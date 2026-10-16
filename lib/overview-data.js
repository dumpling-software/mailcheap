import "server-only";
import { sql } from "drizzle-orm";
import { query, timestamp } from "@/lib/db";
import { MESSAGE_STAT_FIELDS, MESSAGE_STAT_KEYS } from "@/lib/message-stats";
import {
	PERIOD_DAYS,
	buildHourlySeries,
	buildSubscriberSeries,
	periodDayKeys,
	splitPeriods,
} from "@/lib/overview-series";
import { DEFAULT_TIME_ZONE, hourIn, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";

const DAY_MS = 24 * 60 * 60 * 1000;
const STAT_KEYS = MESSAGE_STAT_KEYS;
const LEFT_STATUSES = ["unsubscribed", "bounced", "complained"];
const IMPORT_SOURCES = ["import"];
// Imports write the unsubscribe time (and suppressions) as they create the contact, so a leave
// recorded within a minute of creation happened before the contact came to Mailcheap, at an unknown date.
const IMPORT_WINDOW_MS = 60_000;
const IMPORT_WINDOW = sql.raw(`interval '${IMPORT_WINDOW_MS} milliseconds'`);

// When a contact left: an unsubscribe, or a spam complaint about this newsletter.
const LEFT_AT = sql`coalesce(c.unsubscribed_at, c.complained_at)`;

// The later of the two: a contact who subscribes again gets a new subscribedAt but keeps an old confirmedAt.
const JOINED_AT = sql`greatest(c.subscribed_at, c.confirmed_at)`;
// Imported rows without a signup date get the import time: those contacts joined earlier, on an unknown
// day, so they count from the start of the chart rather than as a spike on the import day.
const JOINED_BEFORE_IMPORT = sql`(c.source in ${IMPORT_SOURCES} and abs(extract(epoch from c.subscribed_at - c.created_at)) * 1000 < ${IMPORT_WINDOW_MS})`;

export function dayOf(column, timeZone) {
	return sql`to_char(${column} at time zone ${timeZone}, 'YYYY-MM-DD')`;
}

// The day a contact joined, or null when it was before the range (or unknown): they're in the starting count.
function joinedDay(rangeStart, timeZone) {
	return sql`case when ${JOINED_BEFORE_IMPORT} or ${JOINED_AT} < ${timestamp(rangeStart)} then null else ${dayOf(JOINED_AT, timeZone)} end`;
}

function joinedKey(contact, rangeStart, timeZone) {
	const joined = new Date(Math.max(contact.subscribedAt ?? 0, contact.confirmedAt ?? 0));
	const isImportTime =
		IMPORT_SOURCES.includes(contact.source) &&
		Math.abs(contact.subscribedAt - contact.createdAt) < IMPORT_WINDOW_MS;
	return isImportTime || joined < rangeStart ? null : toDateKey(joined, timeZone);
}

// Postgres' timezone list can lag the browser's; such a zone falls back to UTC rather than failing the page.
const knownZones = new Map();
export async function databaseZone(timeZone) {
	if (!knownZones.has(timeZone)) {
		const rows = await query(sql`select 1 from pg_timezone_names where name = ${timeZone}`);
		knownZones.set(timeZone, rows.length > 0);
	}
	return knownZones.get(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

function hasLeftInMailcheap(leftAt, contact) {
	return Boolean(leftAt) && leftAt.getTime() > contact.createdAt.getTime() + IMPORT_WINDOW_MS;
}

function toDate(value) {
	return value instanceof Date || value == null ? value : new Date(value);
}

// Active subscribers at the end of each of the last 60 days. Active contacts count from the day they
// joined (confirmed, for confirmed opt-in; CSV imports keep the file's signup date). Contacts who
// left count until they left, when Mailcheap knows the date: unsubscribedAt or complainedAt, or the
// suppression a hard bounce created. Pending, dormant and contacts imported as unsubscribed or bounced have no such
// date and are left out of every day.
export async function getSubscriberHistory({ newsletterId, timeZone, now = new Date() }) {
	const dayKeys = periodDayKeys(toDateKey(now, timeZone));
	const rangeStart = startOfDateKey(dayKeys[0], timeZone);
	const zone = await databaseZone(timeZone);

	const [[{ count: activeBefore }], activeJoins, unsubscribes, suppressionRows] = await Promise.all([
		query(sql`select count(*)::int as count from contacts c
			where c.newsletter_id = ${newsletterId} and c.status = 'active' and c.subscribed_at < ${timestamp(rangeStart)}`),
		query(sql`select ${joinedDay(rangeStart, zone)} as joined, count(*)::int as count from contacts c
			where c.newsletter_id = ${newsletterId} and c.status = 'active' and c.subscribed_at >= ${timestamp(rangeStart)}
			group by 1`),
		query(sql`select ${joinedDay(rangeStart, zone)} as joined, ${dayOf(LEFT_AT, zone)} as left_day, count(*)::int as count
			from contacts c
			where c.newsletter_id = ${newsletterId} and c.status in ${LEFT_STATUSES}
				and ${LEFT_AT} >= ${timestamp(rangeStart)}
				and ${LEFT_AT} > c.created_at + ${IMPORT_WINDOW}
			group by 1, 2`),
		// Each recent suppression with this newsletter's contact for the address, in the same round trip.
		query(sql`select s.created_at as left_at, c.source, c.subscribed_at, c.confirmed_at, c.unsubscribed_at, c.created_at
			from suppressions s
			join contacts c on c.email = s.email and c.newsletter_id = ${newsletterId} and c.status = 'bounced'
			where s.reason = 'bounce' and (s.detail is null or s.detail not in ${IMPORT_SOURCES})
				and s.created_at >= ${timestamp(rangeStart)}`),
	]);
	const suppressions = suppressionRows.map((row) => ({
		leftAt: toDate(row.left_at),
		contact: {
			source: row.source,
			subscribedAt: toDate(row.subscribed_at),
			confirmedAt: toDate(row.confirmed_at),
			unsubscribedAt: toDate(row.unsubscribed_at),
			createdAt: toDate(row.created_at),
		},
	}));

	let baseline = activeBefore;
	const joins = {};
	const leaves = {};
	function addLeaver(joinedKey, leftKey, count = 1) {
		if (joinedKey) joins[joinedKey] = (joins[joinedKey] ?? 0) + count;
		else baseline += count;
		leaves[leftKey] = (leaves[leftKey] ?? 0) + count;
	}

	for (const { joined, count } of activeJoins) {
		if (joined) joins[joined] = (joins[joined] ?? 0) + count;
		else baseline += count;
	}
	for (const { joined, left_day: leftDay, count } of unsubscribes) addLeaver(joined, leftDay, count);
	for (const { leftAt, contact } of suppressions) {
		if (hasLeftInMailcheap(contact.unsubscribedAt, contact) || !hasLeftInMailcheap(leftAt, contact)) continue;
		addLeaver(joinedKey(contact, rangeStart, timeZone), toDateKey(leftAt, timeZone));
	}

	return splitPeriods(buildSubscriberSeries({ dayKeys, baseline, joins, leaves }));
}

function emptyStats() {
	return Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
}

const MESSAGE_COUNTS = sql.join(
	Object.entries(MESSAGE_STAT_FIELDS).map(
		([key, field]) => sql`count(${sql.identifier(field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))})::int as ${sql.identifier(key)}`
	),
	sql`, `
);
const CAMPAIGN_SUMS = sql.join(
	STAT_KEYS.map((key) => sql`coalesce(sum((stats->>${key})::int), 0)::int as ${sql.identifier(key)}`),
	sql`, `
);

// Issues and welcome emails of the last 30 days and the 30 days before.
export async function getEmailStats({ newsletterId, now = new Date() }) {
	const since = new Date(now.getTime() - PERIOD_DAYS * DAY_MS);
	const previousSince = new Date(now.getTime() - 2 * PERIOD_DAYS * DAY_MS);
	const period = (column) => sql`case when ${column} >= ${timestamp(since)} then 'current' else 'previous' end`;
	const campaignAt = sql`coalesce(started_at, sent_at)`;

	const [campaignRows, welcomeRows] = await Promise.all([
		query(sql`select ${period(campaignAt)} as period, ${CAMPAIGN_SUMS} from campaigns
			where newsletter_id = ${newsletterId} and ${campaignAt} >= ${timestamp(previousSince)}
			group by 1`),
		query(sql`select ${period(sql`created_at`)} as period, ${MESSAGE_COUNTS} from messages
			where kind = 'welcome' and newsletter_id = ${newsletterId} and created_at >= ${timestamp(previousSince)}
			group by 1`),
	]);

	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const row of [...campaignRows, ...welcomeRows]) {
		for (const key of STAT_KEYS) totals[row.period][key] += row[key] || 0;
	}
	return totals;
}

// Every email SES accepted for the newsletter (issues, welcome, confirmation and test emails), by hour
// of today and yesterday.
export async function getHourlySends({ newsletterId, timeZone, now = new Date() }) {
	const todayKey = toDateKey(now, timeZone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), timeZone);
	const zone = await databaseZone(timeZone);
	const rows = await query(sql`select ${dayOf(sql`sent_at`, zone)} as day,
			extract(hour from sent_at at time zone ${zone})::int as hour, count(*)::int as count
		from messages
		where newsletter_id = ${newsletterId} and sent_at >= ${timestamp(since)}
		group by 1, 2`);
	return buildHourlySeries({ rows, todayKey, currentHour: hourIn(now, timeZone) });
}
