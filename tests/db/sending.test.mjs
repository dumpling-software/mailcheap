import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { campaigns, contacts, messages, suppressions } from "../../lib/db.js";
import { getCleanupPreview, queueCampaign, sendMessageBatch, setQStash } from "../../lib/sending.js";
import { handleSesEvent, recordEngagement } from "../../lib/ses-events.js";
import { setSesClient } from "../../lib/ses.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";
import { fakeQStash, fakeSes } from "../helpers/fakes.mjs";

process.env.SENDING_ENABLED = "true";
process.env.QSTASH_TOKEN = "test";
process.env.APP_URL = "https://mail.example.com";
process.env.SESSION_SECRET = "s".repeat(40);

let testDb;
let ses;
let qstash;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());
beforeEach(() => {
	ses = fakeSes();
	qstash = fakeQStash();
	setSesClient(ses);
	setQStash(qstash);
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

async function seedCampaign(newsletter, values = {}) {
	const [campaign] = await testDb.db
		.insert(campaigns)
		.values({ newsletterId: newsletter._id, subject: "Issue 1", previewText: "Inside", format: "markdown", markdown: "Hello **there**", ...values })
		.returning();
	return campaign;
}

async function reload(table, id) {
	const [row] = await testDb.db.select().from(table).where(eq(table._id, id));
	return row;
}

function queuedIds() {
	return qstash.published.flatMap(({ body }) => body.messageIds);
}

test("a send reaches active, unsuppressed contacts, most engaged first, once each", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const quiet = await seedContact(db, newsletter, { email: "quiet@example.com" });
	const clicker = await seedContact(db, newsletter, { email: "clicker@example.com", lastClickAt: daysAgo(2) });
	const opener = await seedContact(db, newsletter, { email: "opener@example.com", lastOpenAt: daysAgo(1) });
	await seedContact(db, newsletter, { email: "left@example.com", status: "unsubscribed" });
	await seedContact(db, newsletter, { email: "bounced@example.com" });
	await db.insert(suppressions).values({ email: "bounced@example.com", reason: "bounce" });
	const other = await seedNewsletter(db);
	await seedContact(db, other, { email: "elsewhere@example.com" });
	const campaign = await seedCampaign(newsletter);

	const { recipients } = await queueCampaign(campaign._id);
	assert.equal(recipients, 3);
	const ids = queuedIds();
	const order = await Promise.all(ids.map(async (id) => (await reload(messages, id)).contactId));
	assert.deepEqual(order, [clicker._id, opener._id, quiet._id]);
	const queued = await reload(campaigns, campaign._id);
	assert.equal(queued.status, "sending");
	assert.equal(queued.stats.recipients, 3);
	assert.ok(queued.startedAt instanceof Date);

	const result = await sendMessageBatch(ids);
	assert.deepEqual(result, { sent: 3, failed: 0, suppressed: 0, skipped: 0, retry: false });
	assert.deepEqual(
		ses.sent.map(({ Destination }) => Destination.ToAddresses[0]),
		["clicker@example.com", "opener@example.com", "quiet@example.com"]
	);
	const html = ses.sent[0].Content.Simple.Body.Html.Data;
	assert.ok(html.includes("https://mail.example.com/o/"), "tracked");
	assert.match(html, /unsubscribe\?token=/);

	const sent = await reload(campaigns, campaign._id);
	assert.equal(sent.status, "sent");
	assert.equal(sent.stats.sent, 3);
	assert.ok(sent.sentAt instanceof Date);
	const reader = await reload(contacts, quiet._id);
	assert.equal(reader.stats.sent, 1);
	assert.equal(reader.ignoredIssues, 1);

	const retry = await sendMessageBatch(ids);
	assert.equal(retry.sent, 0, "a retried batch never sends twice");
	assert.equal(ses.sent.length, 3);
	await assert.rejects(queueCampaign(campaign._id), /already sent/);
});

test("a contact who leaves after the audience is chosen is skipped", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const contact = await seedContact(db, newsletter);
	const campaign = await seedCampaign(newsletter);
	await queueCampaign(campaign._id);
	await db.update(contacts).set({ status: "unsubscribed" }).where(eq(contacts._id, contact._id));
	const result = await sendMessageBatch(queuedIds());
	assert.equal(result.suppressed, 1);
	assert.equal(ses.sent.length, 0);
});

test("a warm-up send goes to the most engaged first, and the next step to the rest", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	for (let index = 0; index < 5; index++) {
		await seedContact(db, newsletter, { lastOpenAt: index < 2 ? daysAgo(index + 1) : null });
	}
	const campaign = await seedCampaign(newsletter, { audienceLimit: 2 });
	assert.equal((await queueCampaign(campaign._id)).recipients, 2);
	await sendMessageBatch(queuedIds());
	const { sendToMoreContacts } = await import("../../lib/sending.js");
	qstash.published.length = 0;
	const more = await sendToMoreContacts(campaign._id);
	assert.equal(more.added, 3);
	assert.equal((await sendMessageBatch(queuedIds())).sent, 3);
});

test("opens and clicks count once per message and reset the list cleanup", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const contact = await seedContact(db, newsletter, { ignoredIssues: 3 });
	const campaign = await seedCampaign(newsletter);
	await queueCampaign(campaign._id);
	const [messageId] = queuedIds();
	await sendMessageBatch([messageId]);

	// Clicks in the first 30 seconds are link scanners (lib/tracking.js).
	await db.update(messages).set({ sentAt: daysAgo(1) }).where(eq(messages._id, messageId));
	await recordEngagement({ messageId, type: "Open" });
	await recordEngagement({ messageId, type: "Open" });
	await recordEngagement({ messageId, type: "Click", userAgent: "Mozilla/5.0" });
	const message = await reload(messages, messageId);
	assert.ok(message.openedAt && message.clickedAt);
	const stats = (await reload(campaigns, campaign._id)).stats;
	assert.equal(stats.opened, 1);
	assert.equal(stats.clicked, 1);
	const reader = await reload(contacts, contact._id);
	assert.equal(reader.ignoredIssues, 0);
	assert.equal(reader.stats.opens, 1);
	assert.equal(reader.stats.clicks, 1);
	assert.ok(reader.lastClickAt instanceof Date && reader.lastEngagedAt instanceof Date);
});

test("SES deliveries and hard bounces update the message, the campaign and the suppression list", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const contact = await seedContact(db, newsletter, { email: "gone@example.com" });
	const campaign = await seedCampaign(newsletter);
	await queueCampaign(campaign._id);
	const [messageId] = queuedIds();
	await sendMessageBatch([messageId]);
	const { sesMessageId } = await reload(messages, messageId);
	const mail = { messageId: sesMessageId, destination: ["gone@example.com"], tags: { message_id: [messageId] } };

	await handleSesEvent({ eventType: "Delivery", mail, delivery: { timestamp: new Date().toISOString() } });
	await handleSesEvent({ eventType: "Delivery", mail, delivery: { timestamp: new Date().toISOString() } });
	assert.equal((await reload(campaigns, campaign._id)).stats.delivered, 1, "SNS redeliveries count once");

	await handleSesEvent({
		eventType: "Bounce",
		mail,
		bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "gone@example.com" }] },
	});
	assert.equal((await reload(messages, messageId)).status, "bounced");
	assert.equal((await reload(campaigns, campaign._id)).stats.bounced, 1);
	assert.equal((await reload(contacts, contact._id)).status, "bounced");
	const [suppression] = await db.select().from(suppressions).where(eq(suppressions.email, "gone@example.com"));
	assert.equal(suppression.reason, "bounce");
});

test("with the list cleanup on, cold contacts get the last-chance email instead of the issue", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St", cleanup: { enabled: true, issues: 3, days: 60 } });
	await seedContact(db, newsletter, { lastOpenAt: daysAgo(1) });
	const cold = await seedContact(db, newsletter, { ignoredIssues: 5, subscribedAt: daysAgo(400) });
	const campaign = await seedCampaign(newsletter);

	const preview = await getCleanupPreview(campaign._id);
	assert.equal(preview.issue, 1);
	assert.equal(preview.lastChance.length, 1);

	await queueCampaign(campaign._id);
	const rows = await db.select().from(messages).where(eq(messages.campaignId, campaign._id));
	assert.deepEqual(rows.map(({ kind }) => kind).toSorted(), ["campaign", "last-chance"]);
	assert.equal(rows.find(({ kind }) => kind === "last-chance").contactId, cold._id);
});
