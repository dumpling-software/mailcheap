import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { automations, campaigns, contactEvents, contacts, enrollments, getDb, messages, newsletters } from "@/lib/db";

const TIMELINE_LIMIT = 200;

// Everything about one person in one newsletter: their memberships elsewhere, runs through automations,
// and a timeline of app events and emails, newest first.
export async function getContactDetail(contact) {
	const db = getDb();
	const [memberships, runs, events, sent] = await Promise.all([
		db
			.select({ _id: contacts._id, status: contacts.status, newsletterId: contacts.newsletterId, newsletterName: newsletters.name })
			.from(contacts)
			.innerJoin(newsletters, eq(newsletters._id, contacts.newsletterId))
			.where(eq(contacts.email, contact.email))
			.orderBy(asc(newsletters.createdAt)),
		db
			.select({
				_id: enrollments._id,
				status: enrollments.status,
				currentNodeId: enrollments.currentNodeId,
				nextRunAt: enrollments.nextRunAt,
				exitReason: enrollments.exitReason,
				enrolledAt: enrollments.enrolledAt,
				finishedAt: enrollments.finishedAt,
				history: enrollments.history,
				automationId: automations._id,
				automationName: automations.name,
			})
			.from(enrollments)
			.innerJoin(automations, eq(automations._id, enrollments.automationId))
			.where(eq(enrollments.contactId, contact._id))
			.orderBy(desc(enrollments.enrolledAt)),
		db
			.select({ name: contactEvents.name, properties: contactEvents.properties, occurredAt: contactEvents.occurredAt })
			.from(contactEvents)
			.where(eq(contactEvents.contactId, contact._id))
			.orderBy(desc(contactEvents.occurredAt))
			.limit(TIMELINE_LIMIT),
		db
			.select({
				kind: messages.kind,
				status: messages.status,
				nodeId: messages.nodeId,
				sentAt: messages.sentAt,
				createdAt: messages.createdAt,
				openedAt: messages.openedAt,
				clickedAt: messages.clickedAt,
				campaignId: messages.campaignId,
				campaignSubject: campaigns.subject,
				automationId: messages.automationId,
				automationName: automations.name,
			})
			.from(messages)
			.leftJoin(campaigns, eq(campaigns._id, messages.campaignId))
			.leftJoin(automations, eq(automations._id, messages.automationId))
			.where(eq(messages.contactId, contact._id))
			.orderBy(desc(messages.createdAt))
			.limit(TIMELINE_LIMIT),
	]);

	const timeline = [
		...events.map((event) => ({ type: "event", at: event.occurredAt, ...event })),
		...sent.map((message) => ({ type: "email", at: message.sentAt ?? message.createdAt, ...message })),
		...runs.flatMap((run) => [
			{ type: "enrolled", at: run.enrolledAt, automationId: run.automationId, automationName: run.automationName },
			...(run.finishedAt
				? [{ type: run.status, at: run.finishedAt, automationId: run.automationId, automationName: run.automationName, reason: run.exitReason }]
				: []),
		]),
	]
		.filter(({ at }) => at)
		.sort((a, b) => new Date(b.at) - new Date(a.at))
		.slice(0, TIMELINE_LIMIT);
	return { memberships, runs, timeline };
}
