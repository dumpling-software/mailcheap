import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { contactEvents, contacts, events, getDb, messages, query, suppressions } from "@/lib/db";
import { changedProperties } from "@/lib/properties";
import { findNewsletter, findNewsletterBySlug } from "@/lib/records";
import { isUuid } from "@/lib/validation";

// The API names a newsletter by slug or id. A key made for one newsletter only reaches that one, and
// can leave the newsletter out.
export async function resolveNewsletter(given, apiKey) {
	const value = typeof given === "string" && given.trim() ? given : apiKey?.newsletterId;
	if (typeof value !== "string" || !value.trim()) return { status: 400, error: "newsletter is required" };
	const reference = value.trim().toLowerCase();
	const newsletter = isUuid(reference) ? await findNewsletter(reference) : await findNewsletterBySlug(reference);
	if (!newsletter) return { status: 404, error: "Newsletter not found" };
	if (apiKey?.newsletterId && apiKey.newsletterId !== newsletter._id) {
		return { status: 403, error: "This API key is for another newsletter" };
	}
	return { newsletter };
}

// Merges properties into the contact's, in one statement; null values remove a key. Returns the
// contact's properties before and after, and what changed.
export async function mergeProperties(contactId, properties) {
	const entries = Object.entries(properties ?? {});
	if (entries.length === 0) return { changes: [] };
	const set = Object.fromEntries(entries.filter(([, value]) => value !== null));
	const removed = entries.filter(([, value]) => value === null).map(([key]) => key);
	const [row] = await query(sql`
		with previous as (select id, properties from ${contacts} where id = ${contactId} for update)
		update ${contacts} set properties = (contacts.properties || ${JSON.stringify(set)}::jsonb)
			- array(select jsonb_array_elements_text(${JSON.stringify(removed)}::jsonb))
		from previous where contacts.id = previous.id
		returning previous.properties as before, contacts.properties as after`);
	if (!row) return { changes: [] };
	const before = parseJson(row.before);
	const after = parseJson(row.after);
	return { before, after, changes: changedProperties(before, after) };
}

// postgres-js leaves jsonb as text in raw results.
function parseJson(value) {
	return typeof value === "string" ? JSON.parse(value) : (value ?? {});
}

export async function recordEvent({ newsletter, contact, name, properties = {}, occurredAt = new Date() }) {
	const [event] = await getDb()
		.insert(contactEvents)
		.values({ newsletterId: newsletter._id, contactId: contact._id, name, properties, occurredAt })
		.returning();
	return event;
}

// GDPR erasure: the address's contacts (in one newsletter, or all), their events, and their email on
// sent messages, which keep counting in campaign stats under an erased address. Erasing everywhere
// also drops the address from the suppression list and the SES problem log.
export async function eraseContact({ email, newsletterId }) {
	const db = getDb();
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({ _id: contacts._id })
			.from(contacts)
			.where(and(eq(contacts.email, email), newsletterId ? eq(contacts.newsletterId, newsletterId) : undefined));
		const ids = rows.map(({ _id }) => _id);
		if (ids.length > 0) {
			await tx.update(messages).set({ email: "erased@invalid", contactId: null }).where(inArray(messages.contactId, ids));
			await tx.delete(contactEvents).where(inArray(contactEvents.contactId, ids));
			await tx.delete(contacts).where(inArray(contacts._id, ids));
		}
		if (!newsletterId) {
			await tx.delete(suppressions).where(eq(suppressions.email, email));
			await tx.delete(events).where(eq(events.email, email));
		}
		return { deleted: ids.length };
	});
}

