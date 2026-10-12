import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { sendAlert } from "../../lib/alerts.js";
import { generateApiKey } from "../../lib/api-keys.js";
import { alerts, apiKeys, campaigns, contacts, messages } from "../../lib/db.js";
import { getUnsubscribeLinks } from "../../lib/unsubscribe.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

process.env.SESSION_SECRET = "s".repeat(40);
process.env.APP_URL = "https://mail.example.com";
delete process.env.SENDING_ENABLED;

let testDb;
let apiKey;
before(async () => {
	testDb = await createTestDb();
	const { key, prefix, hash } = generateApiKey();
	await testDb.db.insert(apiKeys).values({ name: "site", prefix, hash });
	apiKey = key;
});
after(() => testDb.close());

function apiRequest(path, body, key = apiKey) {
	return new Request(`https://mail.example.com${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("the contacts API creates a contact once and keeps an unsubscribe", async () => {
	const { POST } = await import("../../app/api/v1/contacts/route.js");
	const newsletter = await seedNewsletter(testDb.db, { slug: "api-weekly" });

	const created = await POST(apiRequest("/api/v1/contacts", { newsletter: "api-weekly", email: "Dana@Example.com" }));
	assert.equal(created.status, 201);
	const { id, status } = await created.json();
	assert.equal(status, "active");

	await testDb.db.update(contacts).set({ status: "unsubscribed" }).where(eq(contacts._id, id));
	const again = await POST(apiRequest("/api/v1/contacts", { newsletter: "api-weekly", email: "dana@example.com" }));
	assert.equal(again.status, 200);
	assert.equal((await again.json()).status, "unsubscribed");

	assert.equal((await POST(apiRequest("/api/v1/contacts", { newsletter: "nope", email: "a@example.com" }))).status, 404);
	assert.equal((await POST(apiRequest("/api/v1/contacts", { newsletter: newsletter.slug, email: "a@example.com" }, "mc_bad"))).status, 401);
});

test("the campaigns API creates drafts and lists sent issues", async () => {
	const { GET, POST } = await import("../../app/api/v1/campaigns/route.js");
	const newsletter = await seedNewsletter(testDb.db, { slug: "api-drafts" });
	const response = await POST(apiRequest("/api/v1/campaigns", { newsletter: "api-drafts", subject: "Hi", markdown: "# Hello" }));
	assert.equal(response.status, 201);
	const { id } = await response.json();
	const [draft] = await testDb.db.select().from(campaigns).where(eq(campaigns._id, id));
	assert.equal(draft.format, "markdown");
	assert.equal(draft.source, "api");
	assert.equal(draft.newsletterId, newsletter._id);

	const list = await GET(
		new Request("https://mail.example.com/api/v1/campaigns?newsletter=api-drafts", { headers: { authorization: `Bearer ${apiKey}` } })
	);
	assert.deepEqual(await list.json(), { issues: [] });
});

test("an unsubscribe link leaves only its own newsletter and credits the campaign", async () => {
	const { POST } = await import("../../app/api/unsubscribe/route.js");
	const { db } = testDb;
	const weekly = await seedNewsletter(db);
	const monthly = await seedNewsletter(db);
	const inWeekly = await seedContact(db, weekly, { email: "both@example.com" });
	const inMonthly = await seedContact(db, monthly, { email: "both@example.com" });
	const [campaign] = await db.insert(campaigns).values({ newsletterId: weekly._id, status: "sent", startedAt: new Date() }).returning();
	await db.insert(messages).values({
		kind: "campaign",
		campaignId: campaign._id,
		newsletterId: weekly._id,
		contactId: inWeekly._id,
		email: inWeekly.email,
		sentAt: new Date(),
	});

	const { headers } = getUnsubscribeLinks({ contactId: inWeekly._id, newsletterId: weekly._id });
	const url = headers["List-Unsubscribe"].slice(1, -1);
	const response = await POST(new Request(url, { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }));
	assert.equal(response.status, 200);

	const status = async (contact) => (await db.select().from(contacts).where(eq(contacts._id, contact._id)))[0].status;
	assert.equal(await status(inWeekly), "unsubscribed");
	assert.equal(await status(inMonthly), "active", "the same address stays subscribed to the other newsletter");
	const [credited] = await db.select().from(campaigns).where(eq(campaigns._id, campaign._id));
	assert.equal(credited.stats.unsubscribed, 1);
});

test("an alert goes out once per cooldown", async () => {
	await sendAlert({ key: "test-alert", title: "Test", detail: "first" });
	const [first] = await testDb.db.select().from(alerts).where(eq(alerts.key, "test-alert"));
	await sendAlert({ key: "test-alert", title: "Test", detail: "second" });
	const [second] = await testDb.db.select().from(alerts).where(eq(alerts.key, "test-alert"));
	assert.equal(second.lastSentAt.getTime(), first.lastSentAt.getTime(), "inside the cooldown nothing changes");
	await testDb.db.update(alerts).set({ lastSentAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(alerts.key, "test-alert"));
	await sendAlert({ key: "test-alert", title: "Test", detail: "third" });
	const [third] = await testDb.db.select().from(alerts).where(eq(alerts.key, "test-alert"));
	assert.ok(third.lastSentAt > first.lastSentAt);
});
