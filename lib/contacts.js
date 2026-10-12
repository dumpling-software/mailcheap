import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { contacts, getDb, newsletters, query, suppressions, timestamp } from "@/lib/db";
import { engagement } from "@/lib/engagement";

// Newsletters in creation order with their active contacts, counted in the same round trip.
export async function listNewslettersWithActiveCounts() {
	// Spelled out with table names: Drizzle leaves columns unqualified inside a one-table select.
	const activeCount = sql`(select count(*) from contacts where contacts.newsletter_id = newsletters.id and contacts.status = 'active')::int`;
	return getDb()
		.select({
			_id: newsletters._id,
			name: newsletters.name,
			slug: newsletters.slug,
			imageUrl: newsletters.imageUrl,
			fromEmail: newsletters.fromEmail,
			archiveEnabled: newsletters.archiveEnabled,
			requireConfirmation: newsletters.requireConfirmation,
			welcome: newsletters.welcome,
			activeCount: activeCount.mapWith(Number),
		})
		.from(newsletters)
		.orderBy(asc(newsletters.createdAt));
}

// Only an explicit resubscribe reverses an opt-out; bounces and complaints never reverse.
const REACTIVATABLE_STATUSES = ["unsubscribed", "dormant"];
const SUPPRESSED_STATUSES = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" };

export async function findSuppression(email) {
	const [suppression] = await getDb()
		.select({ reason: suppressions.reason })
		.from(suppressions)
		.where(eq(suppressions.email, email));
	return suppression ?? null;
}

// Creates the contact, or finds the one this newsletter already has for the address, in one round trip.
async function insertOrFind({ newsletterId, email, status, source, now }) {
	const [row] = await query(sql`
		with inserted as (
			insert into ${contacts} (newsletter_id, email, status, source, subscribed_at)
			values (${newsletterId}, ${email}, ${status}, ${source ?? null}, ${timestamp(now)})
			on conflict (newsletter_id, email) do nothing
			returning id
		)
		select id, true as created from inserted
		union all
		select id, false as created from ${contacts}
		where newsletter_id = ${newsletterId} and email = ${email} and not exists (select 1 from inserted)`);
	const [contact] = await getDb().select().from(contacts).where(eq(contacts._id, row.id));
	return { contact, created: row.created };
}

export async function upsertContact({ newsletter, email, source, resubscribe }) {
	const joinStatus = newsletter.requireConfirmation ? "pending" : "active";
	const suppression = await findSuppression(email);
	const status = suppression ? (SUPPRESSED_STATUSES[suppression.reason] ?? "unsubscribed") : joinStatus;
	const { contact, created } = await insertOrFind({ newsletterId: newsletter._id, email, status, source, now: new Date() });

	if (created || !resubscribe || suppression) return { contact, created };
	const db = getDb();
	// Signing up again is a sign of life, and brings back a contact who left or went dormant.
	if (contact.status === "active") {
		const [updated] = await db.update(contacts).set(engagement()).where(eq(contacts._id, contact._id)).returning();
		return { contact: updated ?? contact, created };
	}
	if (!REACTIVATABLE_STATUSES.includes(contact.status)) return { contact, created };
	const [reactivated] = await db
		.update(contacts)
		.set({ status: joinStatus, subscribedAt: new Date(), unsubscribedAt: null, ...engagement() })
		.where(and(eq(contacts._id, contact._id), inArray(contacts.status, REACTIVATABLE_STATUSES)))
		.returning();
	return { contact: reactivated ?? contact, created };
}

// The click on the confirmation link. A contact that already confirmed stays as it is.
export async function confirmContact({ contactId, newsletterId }) {
	const db = getDb();
	const [confirmed] = await db
		.update(contacts)
		.set({ status: "active", confirmedAt: new Date(), ...engagement() })
		.where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId), eq(contacts.status, "pending")))
		.returning();
	if (confirmed) return { contact: confirmed, confirmed: true };
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId)));
	return { contact: contact ?? null, confirmed: false };
}

// The "Yes, keep sending it" click in the last-chance email. It also brings back a contact who went
// dormant; unsubscribes, bounces and complaints stay as they are.
export async function keepContact({ contactId, newsletterId }) {
	const db = getDb();
	const [contact] = await db
		.select({ _id: contacts._id, email: contacts.email, status: contacts.status })
		.from(contacts)
		.where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId)));
	if (!contact || !["active", "dormant"].includes(contact.status)) return null;
	if (contact.status === "dormant" && (await findSuppression(contact.email))) return null;
	const [kept] = await db
		.update(contacts)
		.set({ status: "active", ...engagement() })
		.where(and(eq(contacts._id, contact._id), inArray(contacts.status, ["active", "dormant"])))
		.returning();
	return kept ?? null;
}
