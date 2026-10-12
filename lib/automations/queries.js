import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { automations, enrollments, getDb, newsletters, query } from "@/lib/db";

const EMPTY_COUNTS = { active: 0, waiting: 0, completed: 0, exited: 0 };

function countsBy(rows) {
	const counts = new Map();
	for (const { automationId, status, count } of rows) {
		const entry = counts.get(automationId) ?? { ...EMPTY_COUNTS };
		entry[status] = count;
		counts.set(automationId, entry);
	}
	return counts;
}

async function enrollmentCounts(automationId) {
	const rows = await getDb()
		.select({ automationId: enrollments.automationId, status: enrollments.status, count: sql`count(*)::int`.mapWith(Number) })
		.from(enrollments)
		.where(automationId ? eq(enrollments.automationId, automationId) : undefined)
		.groupBy(enrollments.automationId, enrollments.status);
	return countsBy(rows);
}

// Every automation with how many contacts are in it, waiting, done and gone.
// All of them, or one newsletter's.
export async function listAutomationsWithCounts(newsletterId) {
	const [rows, counts] = await Promise.all([
		getDb()
			.select({
				_id: automations._id,
				name: automations.name,
				status: automations.status,
				trigger: automations.trigger,
				newsletterId: automations.newsletterId,
				updatedAt: automations.updatedAt,
				newsletterName: newsletters.name,
			})
			.from(automations)
			.innerJoin(newsletters, eq(newsletters._id, automations.newsletterId))
			.where(newsletterId ? eq(automations.newsletterId, newsletterId) : undefined)
			.orderBy(asc(newsletters.createdAt), asc(automations.createdAt)),
		enrollmentCounts(),
	]);
	return rows.map((row) => ({ ...row, counts: counts.get(row._id) ?? { ...EMPTY_COUNTS } }));
}

export async function getEnrollmentCounts(automationId) {
	return (await enrollmentCounts(automationId)).get(automationId) ?? { ...EMPTY_COUNTS };
}

// Per send node: delivery and engagement from its messages, and unsubscribes within 3 days of it.
export async function getNodeStats(automationId) {
	const rows = await query(sql`
		select m.node_id as node_id,
			count(m.sent_at)::int as sent,
			count(m.delivered_at)::int as delivered,
			count(m.opened_at)::int as opened,
			count(m.clicked_at)::int as clicked,
			count(m.bounced_at)::int as bounced,
			count(m.complained_at)::int as complained,
			count(*) filter (where c.status = 'unsubscribed'
				and c.unsubscribed_at between m.sent_at and m.sent_at + interval '3 days')::int as unsubscribed
		from messages m
		left join contacts c on c.id = m.contact_id
		where m.automation_id = ${automationId} and m.kind = 'automation'
		group by m.node_id`);
	return Object.fromEntries(rows.map(({ node_id: nodeId, ...stats }) => [nodeId, stats]));
}
