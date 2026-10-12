import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { campaigns, messages, query } from "../../lib/db.js";
import { findRecentCampaigns, findSendTimes } from "../../lib/campaign-queries.js";
import { cleanupTotalsQuery } from "../../lib/engagement.js";
import { getEmailStats, getHourlySends, getSubscriberHistory } from "../../lib/overview-data.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

let testDb;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());

const NOW = new Date("2026-10-12T15:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY_MS);

test("subscriber history counts joins and leaves by day in the reader's time zone", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const old = daysAgo(200);
	await seedContact(db, newsletter, { subscribedAt: old, createdAt: old });
	await seedContact(db, newsletter, { subscribedAt: daysAgo(3), createdAt: daysAgo(3) });
	// Joined at 23:30 UTC on Oct 10: Oct 11 in Tokyo.
	await seedContact(db, newsletter, { subscribedAt: new Date("2026-10-10T23:30:00Z"), createdAt: new Date("2026-10-10T23:30:00Z") });
	await seedContact(db, newsletter, { status: "unsubscribed", subscribedAt: old, createdAt: old, unsubscribedAt: daysAgo(1) });
	// Imported as unsubscribed: no known date, never counted.
	await seedContact(db, newsletter, { status: "unsubscribed", source: "import", subscribedAt: daysAgo(2), createdAt: daysAgo(2), unsubscribedAt: daysAgo(2) });

	const utc = await getSubscriberHistory({ newsletterId: newsletter._id, timeZone: "UTC", now: NOW });
	assert.equal(utc.total, 3);
	const tokyo = await getSubscriberHistory({ newsletterId: newsletter._id, timeZone: "Asia/Tokyo", now: NOW });
	assert.equal(tokyo.total, 3);
	const day = (history, key) => history.current.find((point) => point.key === key)?.total;
	assert.equal(day(utc, "2026-10-10") - day(utc, "2026-10-09"), 1, "UTC: joined on the 10th");
	assert.equal(day(tokyo, "2026-10-11") - day(tokyo, "2026-10-10"), 1, "Tokyo: joined on the 11th");
});

test("email stats add up campaigns of the last 30 days and the 30 before", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	await db.insert(campaigns).values([
		{ newsletterId: newsletter._id, status: "sent", startedAt: daysAgo(2), stats: { sent: 100, delivered: 98, opened: 40, clicked: 5, bounced: 2, complained: 0 } },
		{ newsletterId: newsletter._id, status: "sent", startedAt: daysAgo(10), stats: { sent: 50, delivered: 50, opened: 10, clicked: 1, bounced: 0, complained: 1 } },
		{ newsletterId: newsletter._id, status: "sent", startedAt: daysAgo(45), stats: { sent: 70, delivered: 70, opened: 7, clicked: 0, bounced: 0, complained: 0 } },
	]);
	const stats = await getEmailStats({ newsletterId: newsletter._id, now: NOW });
	assert.equal(stats.current.sent, 150);
	assert.equal(stats.current.opened, 50);
	assert.equal(stats.current.complained, 1);
	assert.equal(stats.previous.sent, 70);
});

test("hourly sends group today's and yesterday's emails by local hour", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const at = (iso) => ({ kind: "test", newsletterId: newsletter._id, email: "a@example.com", sentAt: new Date(iso) });
	await db.insert(messages).values([at("2026-10-12T09:10:00Z"), at("2026-10-12T09:50:00Z"), at("2026-10-11T14:00:00Z")]);
	const hours = await getHourlySends({ newsletterId: newsletter._id, timeZone: "UTC", now: NOW });
	assert.equal(hours[9].today, 2);
	assert.equal(hours[14].yesterday, 1);
});

test("campaign lists put upcoming sends first, then by send date, and skip discarded drafts", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const [sent, scheduled, , discarded] = await db
		.insert(campaigns)
		.values([
			{ newsletterId: newsletter._id, subject: "sent", status: "sent", startedAt: daysAgo(5), sentAt: daysAgo(5) },
			{ newsletterId: newsletter._id, subject: "scheduled", status: "scheduled", scheduledAt: new Date(NOW.getTime() + DAY_MS) },
			{ newsletterId: newsletter._id, subject: "older", status: "sent", startedAt: daysAgo(20), sentAt: daysAgo(20) },
			{ newsletterId: newsletter._id, subject: "discarded", status: "canceled" },
		])
		.returning();
	const recent = await findRecentCampaigns(10, newsletter._id);
	assert.deepEqual(recent.map(({ subject }) => subject).slice(0, 2), ["scheduled", "sent"]);
	assert.ok(!recent.some(({ _id }) => _id === discarded._id));
	assert.equal(recent[0].html, undefined, "lists don't load the HTML");

	const times = await findSendTimes({ newsletterId: newsletter._id, excludeId: sent._id });
	assert.equal(times[0].at.getTime(), scheduled.scheduledAt.getTime());
	assert.ok(times.every(({ at }) => at instanceof Date));
});

test("cleanup totals split last-chance contacts into waiting, kept and dormant", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	await seedContact(db, newsletter, { lastChanceAt: daysAgo(5), subscribedAt: daysAgo(400) });
	await seedContact(db, newsletter, { lastChanceAt: daysAgo(5), subscribedAt: daysAgo(400), lastOpenAt: daysAgo(1) });
	await seedContact(db, newsletter, { status: "dormant", lastChanceAt: daysAgo(30) });
	await seedContact(db, newsletter);
	const [totals] = await query(cleanupTotalsQuery(newsletter._id));
	assert.deepEqual({ ...totals }, { waiting: 1, kept: 1, dormant: 1 });
});
