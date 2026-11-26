import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { generateApiKey } from "../../lib/api-keys.js";
import { apiKeys, campaigns, contacts, emailRules, messages, suppressions } from "../../lib/db.js";
import { forgetEmailRules } from "../../lib/email-check.js";
import { queueCampaign, sendMessageBatch, setQStash } from "../../lib/sending.js";
import { setSesClient } from "../../lib/ses.js";
import { getUnsubscribeLinks, verifyUnsubscribeToken } from "../../lib/unsubscribe.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";
import { fakeQStash, fakeSes } from "../helpers/fakes.mjs";

process.env.SENDING_ENABLED = "true";
process.env.QSTASH_TOKEN = "test";
process.env.APP_URL = "https://mail.example.com";
process.env.SESSION_SECRET = "s".repeat(40);

let testDb;
let apiKey;
let ses;
let qstash;
before(async () => {
	testDb = await createTestDb();
	const { key, prefix, hash } = generateApiKey();
	await testDb.db.insert(apiKeys).values({ name: "app", prefix, hash });
	apiKey = key;
});
after(() => testDb.close());
beforeEach(() => {
	ses = fakeSes();
	qstash = fakeQStash();
	setSesClient(ses);
	setQStash(qstash);
});

async function reload(table, id) {
	const [row] = await testDb.db.select().from(table).where(eq(table._id, id));
	return row;
}

async function seedCampaign(newsletter, values = {}) {
	const [campaign] = await testDb.db
		.insert(campaigns)
		.values({ newsletterId: newsletter._id, subject: "Issue", format: "markdown", markdown: "Hello", ...values })
		.returning();
	return campaign;
}

function api(method, { query = "", body } = {}) {
	return new Request(`https://mail.example.com/api/v1/contacts${query}`, {
		method,
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		...(body && { body: JSON.stringify(body) }),
	});
}

test("a campaign skips contacts who left its topic, in the SQL audience and at send time", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const everything = await seedContact(db, newsletter, { email: "all@example.com" });
	await seedContact(db, newsletter, { email: "no-updates@example.com", unsubscribedTopics: ["product_updates"] });
	const noDrips = await seedContact(db, newsletter, { email: "no-drips@example.com", unsubscribedTopics: ["automations"] });

	const updates = await seedCampaign(newsletter);
	assert.equal(updates.topic, "product_updates", "campaigns default to product updates");
	assert.equal((await queueCampaign(updates._id)).recipients, 2);
	const queued = await db.select().from(messages).where(eq(messages.campaignId, updates._id));
	assert.deepEqual(queued.map(({ contactId }) => contactId).toSorted(), [everything._id, noDrips._id].toSorted());

	// Opting out after the audience was picked still stops the email, and its link carries the topic.
	await db.update(contacts).set({ unsubscribedTopics: ["product_updates"] }).where(eq(contacts._id, noDrips._id));
	const result = await sendMessageBatch(queued.map(({ _id }) => _id));
	assert.equal(result.sent, 1);
	assert.equal(result.suppressed, 1);
	const link = ses.sent[0].Content.Simple.Headers.find(({ Name }) => Name === "List-Unsubscribe").Value;
	assert.equal(verifyUnsubscribeToken(new URL(link.slice(1, -1)).searchParams.get("token")).topic, "product_updates");

	const drips = await seedCampaign(newsletter, { topic: "automations" });
	assert.equal((await queueCampaign(drips._id)).recipients, 3, "an automations-topic campaign reaches the product-updates opt-outs");
});

test("a topic link leaves only that topic; scope=all and old links leave the newsletter", async () => {
	const { POST } = await import("../../app/api/unsubscribe/route.js");
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const reader = await seedContact(db, newsletter);
	const [campaign] = await db.insert(campaigns).values({ newsletterId: newsletter._id, status: "sent", startedAt: new Date() }).returning();
	await db.insert(messages).values({ kind: "campaign", campaignId: campaign._id, newsletterId: newsletter._id, contactId: reader._id, email: reader.email, sentAt: new Date() });
	const oneClick = (topic) => {
		const url = getUnsubscribeLinks({ contactId: reader._id, newsletterId: newsletter._id, topic }).headers["List-Unsubscribe"].slice(1, -1);
		return POST(new Request(url, { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }));
	};

	assert.equal((await oneClick("product_updates")).status, 200);
	assert.equal((await oneClick("product_updates")).status, 200, "a second click changes nothing");
	let row = await reload(contacts, reader._id);
	assert.equal(row.status, "active");
	assert.deepEqual(row.unsubscribedTopics, ["product_updates"]);
	assert.equal((await reload(campaigns, campaign._id)).stats.unsubscribed, 1, "credited once");

	await oneClick("automations");
	row = await reload(contacts, reader._id);
	assert.deepEqual(row.unsubscribedTopics, ["product_updates", "automations"]);
	assert.equal(row.status, "active");

	// The page's "Unsubscribe from all" button: the whole newsletter, not counted twice.
	const { pageUrl } = getUnsubscribeLinks({ contactId: reader._id, newsletterId: newsletter._id, topic: "automations" });
	const token = new URL(pageUrl).searchParams.get("token");
	const response = await POST(
		new Request(`https://mail.example.com/api/unsubscribe?token=${token}`, { method: "POST", body: new URLSearchParams({ source: "page", scope: "all" }) })
	);
	assert.equal(response.status, 303);
	assert.equal(new URL(response.headers.get("location")).searchParams.get("scope"), "all");
	assert.equal((await reload(contacts, reader._id)).status, "unsubscribed");
	assert.equal((await reload(campaigns, campaign._id)).stats.unsubscribed, 1);

	const old = await seedContact(db, newsletter);
	await POST(new Request(getUnsubscribeLinks({ contactId: old._id, newsletterId: newsletter._id }).headers["List-Unsubscribe"].slice(1, -1), { method: "POST" }));
	row = await reload(contacts, old._id);
	assert.equal(row.status, "unsubscribed", "a link without a topic is a full unsubscribe");
	assert.deepEqual(row.unsubscribedTopics, []);
});

test("GET reports the status and the effective subscription per topic", async () => {
	const { GET } = await import("../../app/api/v1/contacts/route.js");
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { slug: "prefs-read" });
	await seedContact(db, newsletter, { email: "half@example.com", unsubscribedTopics: ["automations"] });
	await seedContact(db, newsletter, { email: "pending@example.com", status: "pending" });
	await seedContact(db, newsletter, { email: "gone@example.com", status: "unsubscribed" });
	const read = async (email) => {
		const response = await GET(api("GET", { query: `?email=${encodeURIComponent(email)}&newsletter=prefs-read` }));
		return { status: response.status, body: await response.json() };
	};

	assert.deepEqual(await read("Half@Example.com"), {
		status: 200,
		body: { email: "half@example.com", status: "active", topics: { product_updates: true, automations: false } },
	});
	assert.deepEqual((await read("pending@example.com")).body.topics, { product_updates: true, automations: true });
	assert.deepEqual((await read("gone@example.com")).body.topics, { product_updates: false, automations: false });
	assert.equal((await read("missing@example.com")).status, 404);
	assert.equal((await read("not-an-email")).status, 400);
});

test("PATCH saves topics and brings back contacts who opt in, never bounced or suppressed ones", async () => {
	const { PATCH } = await import("../../app/api/v1/contacts/route.js");
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { slug: "prefs" });
	const save = async (email, topics) => {
		const response = await PATCH(api("PATCH", { body: { newsletter: "prefs", email, topics } }));
		return { status: response.status, body: await response.json() };
	};

	const active = await seedContact(db, newsletter, { email: "active@example.com" });
	assert.deepEqual(await save("active@example.com", { product_updates: false }), {
		status: 200,
		body: { email: "active@example.com", status: "active", topics: { product_updates: false, automations: true } },
	});
	assert.deepEqual((await save("active@example.com", { product_updates: true, automations: false })).body.topics, {
		product_updates: true,
		automations: false,
	});
	assert.deepEqual((await reload(contacts, active._id)).unsubscribedTopics, ["automations"]);

	const left = await seedContact(db, newsletter, { email: "left@example.com", status: "unsubscribed", unsubscribedAt: new Date() });
	const back = await save("left@example.com", { product_updates: true, automations: false });
	assert.equal(back.body.status, "active", "turning a topic on is consent to come back");
	assert.deepEqual(back.body.topics, { product_updates: true, automations: false });
	assert.equal((await reload(contacts, left._id)).unsubscribedAt, null);

	await seedContact(db, newsletter, { email: "off@example.com", status: "unsubscribed" });
	assert.equal((await save("off@example.com", { automations: false })).body.status, "unsubscribed", "turning topics off doesn't resubscribe");

	await seedContact(db, newsletter, { email: "dormant@example.com", status: "dormant" });
	assert.equal((await save("dormant@example.com", { automations: true })).body.status, "active");

	const bounced = await seedContact(db, newsletter, { email: "bounced@example.com", status: "bounced" });
	assert.deepEqual(await save("bounced@example.com", { product_updates: true, automations: false }), {
		status: 200,
		body: { email: "bounced@example.com", status: "bounced", topics: { product_updates: false, automations: false } },
	});
	assert.deepEqual((await reload(contacts, bounced._id)).unsubscribedTopics, ["automations"], "the flags are still saved");
	await seedContact(db, newsletter, { email: "complained@example.com", status: "complained" });
	assert.equal((await save("complained@example.com", { product_updates: true })).body.status, "complained");

	await seedContact(db, newsletter, { email: "blocked@example.com", status: "unsubscribed" });
	await db.insert(suppressions).values({ email: "blocked@example.com", reason: "manual" });
	assert.equal((await save("blocked@example.com", { product_updates: true })).body.status, "unsubscribed", "suppressed addresses stay out");
});

test("PATCH adds a missing contact only when a topic is turned on, with the signup checks", async () => {
	const { PATCH } = await import("../../app/api/v1/contacts/route.js");
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { slug: "prefs-new" });
	const save = async (email, topics) => {
		const response = await PATCH(api("PATCH", { body: { newsletter: "prefs-new", email, topics } }));
		return { status: response.status, body: await response.json() };
	};

	assert.equal((await save("nobody@example.com", { product_updates: false, automations: false })).status, 404);
	assert.equal((await db.select().from(contacts).where(eq(contacts.email, "nobody@example.com"))).length, 0);

	const created = await save("New@Example.com", { product_updates: true, automations: false });
	assert.deepEqual(created, {
		status: 200,
		body: { email: "new@example.com", status: "active", topics: { product_updates: true, automations: false } },
	});
	const [row] = await db.select().from(contacts).where(eq(contacts.email, "new@example.com"));
	assert.equal(row.source, "preferences");
	assert.deepEqual(row.unsubscribedTopics, ["automations"]);

	await db.insert(emailRules).values({ kind: "domain", value: "blocked.example", action: "block" });
	forgetEmailRules();
	const refused = await save("someone@blocked.example", { product_updates: true });
	assert.equal(refused.status, 422);
	assert.ok(refused.body.error && refused.body.reason, "the same refusal shape as POST");
	await db.delete(emailRules);
	forgetEmailRules();

	assert.equal((await save("x@example.com", {})).status, 400);
	assert.equal((await save("x@example.com", { newsletter: true })).status, 400);
	assert.equal((await save("x@example.com", { product_updates: "yes" })).status, 400);
});

test("the campaigns API takes a topic, product updates by default", async () => {
	const { POST } = await import("../../app/api/v1/campaigns/route.js");
	const newsletter = await seedNewsletter(testDb.db, { slug: "topic-drafts" });
	const create = (extra) =>
		POST(
			new Request("https://mail.example.com/api/v1/campaigns", {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({ newsletter: newsletter.slug, subject: "Hi", markdown: "Hello", ...extra }),
			})
		);
	const plain = await (await create()).json();
	assert.equal(plain.topic, "product_updates");
	assert.equal((await reload(campaigns, plain.id)).topic, "product_updates");
	const drip = await (await create({ topic: "automations" })).json();
	assert.equal((await reload(campaigns, drip.id)).topic, "automations");
	assert.equal((await create({ topic: "news" })).status, 400);
});
