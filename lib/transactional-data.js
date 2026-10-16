import "server-only";
import { sql } from "drizzle-orm";
import { query, timestamp } from "@/lib/db";
import { databaseZone, dayOf } from "@/lib/overview-data";
import { PERIOD_DAYS, buildHourlySeries } from "@/lib/overview-series";
import { hourIn, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBLEM_STATUSES = ["delayed", "bounced", "complained", "failed"];
const COUNTS = sql`count(*)::int as sent, count(delivered_at)::int as delivered, count(bounced_at)::int as bounced,
	count(complained_at)::int as complained, count(delayed_at)::int as delayed, count(*) filter (where status = 'failed')::int as failed`;

function byDomain(domain) {
	return domain ? sql`and domain = ${domain}` : sql``;
}

function emptyStats() {
	return { sent: 0, delivered: 0, bounced: 0, complained: 0, delayed: 0, failed: 0 };
}

export async function listTransactionalDomains() {
	const rows = await query(sql`select domain, count(*)::int as count from transactional_messages
		where domain is not null group by 1 order by 2 desc, 1`);
	return rows.map(({ domain }) => domain);
}

// The last 30 days and the 30 before, in the shape ListStats takes.
export async function getTransactionalStats({ domain, now = new Date() }) {
	const since = new Date(now.getTime() - PERIOD_DAYS * DAY_MS);
	const previousSince = new Date(now.getTime() - 2 * PERIOD_DAYS * DAY_MS);
	const rows = await query(sql`select case when sent_at >= ${timestamp(since)} then 'current' else 'previous' end as period,
			${COUNTS}
		from transactional_messages
		where sent_at >= ${timestamp(previousSince)} and sent_at <= ${timestamp(now)} ${byDomain(domain)}
		group by 1`);
	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const { period, ...counts } of rows) Object.assign(totals[period], counts);
	return totals;
}

export async function getTransactionalHourly({ domain, timeZone, now = new Date() }) {
	const todayKey = toDateKey(now, timeZone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), timeZone);
	const zone = await databaseZone(timeZone);
	const rows = await query(sql`select ${dayOf(sql`sent_at`, zone)} as day,
			extract(hour from sent_at at time zone ${zone})::int as hour, count(*)::int as count
		from transactional_messages
		where sent_at >= ${timestamp(since)} ${byDomain(domain)}
		group by 1, 2`);
	return buildHourlySeries({ rows, todayKey, currentHour: hourIn(now, timeZone) });
}

export async function getTransactionalProviders({ domain, now = new Date() }) {
	const since = new Date(now.getTime() - PERIOD_DAYS * DAY_MS);
	return query(sql`select coalesce(provider, 'other') as provider, ${COUNTS}
		from transactional_messages
		where sent_at >= ${timestamp(since)} ${byDomain(domain)}
		group by 1 order by 2 desc`);
}

export async function listTransactionalProblems({ domain, limit = 50 }) {
	const rows = await query(sql`select id, domain, email, subject, status, error,
			coalesce(complained_at, bounced_at, delayed_at, sent_at) as occurred_at
		from transactional_messages
		where status in ${PROBLEM_STATUSES} ${byDomain(domain)}
		order by occurred_at desc limit ${limit}`);
	return rows.map((row) => ({ ...row, occurredAt: new Date(row.occurred_at) }));
}
