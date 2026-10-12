import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sendAlert } from "@/lib/alerts";
import { campaigns, contacts, events, getDb, jsonIncrement, later, messages, suppressions } from "@/lib/db";
import { engagement } from "@/lib/engagement";
import { CAMPAIGN_MESSAGE_KINDS, getCampaignStatsPath } from "@/lib/sending-rules";
import { getSesEventPlan, getTrackingPlan } from "@/lib/ses-event-mapping";
import { isLikelyScanner } from "@/lib/tracking";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

// Every send produces a delivery event; storing those raw would fill a small cluster within months.
const RECORDED_EVENT_TYPES = new Set(["Bounce", "Complaint", "Reject", "DeliveryDelay", "RenderingFailure"]);

// The message_id tag covers events that arrive before sesMessageId is saved.
async function findMessage({ sesMessageId, messageId }) {
	const db = getDb();
	if (sesMessageId) {
		const [message] = await db.select().from(messages).where(eq(messages.sesMessageId, sesMessageId)).limit(1);
		if (message) return message;
	}
	if (!messageId) return null;

	const [message] = await db.select().from(messages).where(eq(messages._id, messageId));
	if (!message) return null;
	if (message.sesMessageId && sesMessageId && message.sesMessageId !== sesMessageId) return null;
	if (!message.sesMessageId && sesMessageId) {
		await db
			.update(messages)
			.set({ sesMessageId })
			.where(and(eq(messages._id, message._id), isNull(messages.sesMessageId)));
	}
	return message;
}

// Each counter moves only on the first transition, so SNS redeliveries are harmless.
async function applyMessageUpdates(message, plan) {
	const db = getDb();
	const campaignInc = {};
	const contactInc = {};
	const statsColumn = getCampaignStatsPath(message.kind);

	for (const { field, stat, contactStat } of plan.firsts) {
		const updated = await db
			.update(messages)
			.set({ [field]: plan.occurredAt })
			.where(and(eq(messages._id, message._id), isNull(messages[field])))
			.returning({ _id: messages._id });
		if (updated.length === 0) continue;
		if (stat) campaignInc[stat] = 1;
		if (contactStat) contactInc[contactStat] = 1;
	}

	if (plan.status) {
		const updated = await db
			.update(messages)
			.set({ status: plan.status.to })
			.where(and(eq(messages._id, message._id), inArray(messages.status, plan.status.from)))
			.returning({ _id: messages._id });
		if (updated.length > 0 && plan.status.stat) campaignInc[plan.status.stat] = 1;
	}

	if (plan.error) {
		await db.update(messages).set({ error: plan.error.slice(0, 500) }).where(eq(messages._id, message._id));
	}

	const updates = [];
	if (CAMPAIGN_MESSAGE_KINDS.includes(message.kind) && message.campaignId && Object.keys(campaignInc).length > 0) {
		updates.push(
			db
				.update(campaigns)
				.set({ [statsColumn]: jsonIncrement(campaigns[statsColumn], campaignInc) })
				.where(eq(campaigns._id, message.campaignId))
		);
	}
	if (message.contactId && (plan.engagement || Object.keys(contactInc).length > 0)) {
		const engaged = Object.fromEntries(
			Object.entries(plan.engagement ?? {}).map(([field, at]) => [field, later(contacts[field], at)])
		);
		updates.push(
			db
				.update(contacts)
				.set({
					...engaged,
					...(plan.engagement && engagement(plan.occurredAt)),
					...(Object.keys(contactInc).length > 0 && { stats: jsonIncrement(contacts.stats, contactInc) }),
				})
				.where(eq(contacts._id, message.contactId))
		);
	}
	await Promise.all(updates);
}

// Global: the address is never emailed again, from any newsletter.
async function suppress({ emails, reason, detail, contactStatus, contactStatusFrom }) {
	if (emails.length === 0) return;
	const db = getDb();
	await Promise.all(
		emails.map((email) => {
			const insert = db.insert(suppressions).values({ email, reason, detail });
			// A complaint outranks an earlier bounce or manual suppression.
			return reason === "complaint"
				? insert.onConflictDoUpdate({ target: suppressions.email, set: { reason, detail } })
				: insert.onConflictDoNothing({ target: suppressions.email });
		})
	);
	await db
		.update(contacts)
		.set({ status: contactStatus })
		.where(and(inArray(contacts.email, emails), inArray(contacts.status, contactStatusFrom)));
}

// Mailcheap's own open pixel and click links update messages the way SES events do.
export async function recordEngagement({ messageId, type, userAgent }) {
	const [message] = await getDb()
		.select({
			_id: messages._id,
			kind: messages.kind,
			campaignId: messages.campaignId,
			contactId: messages.contactId,
			sentAt: messages.sentAt,
		})
		.from(messages)
		.where(eq(messages._id, messageId));
	if (!message) return;
	if (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt })) return;
	await applyMessageUpdates(message, getTrackingPlan(type));
}

export async function handleSesEvent(sesEvent) {
	const plan = getSesEventPlan(sesEvent);
	if (!plan) return { handled: false };

	const message = await findMessage(plan);
	if (message) await applyMessageUpdates(message, plan);
	if (plan.suppression) await suppress(plan.suppression);
	if (plan.suppression?.reason === "complaint") {
		await sendAlert({
			key: "complaints",
			title: "Spam complaint",
			detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
			path: message?.campaignId ? `/campaigns/${message.campaignId}` : "",
		});
	}

	if (RECORDED_EVENT_TYPES.has(plan.type)) {
		await getDb().insert(events).values({
			type: plan.type,
			sesMessageId: plan.sesMessageId,
			messageId: message?._id,
			campaignId: message?.campaignId,
			email: plan.email ?? message?.email,
			occurredAt: plan.occurredAt,
			data: plan.data,
		});
	}
	return { handled: true, messageId: message ? String(message._id) : null };
}
