// Unsubscribes and spam complaints stop one newsletter; only hard bounces stop every newsletter.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { importContactRows } from "../../lib/contact-import.js";
import { upsertContact } from "../../lib/contacts.js";
import { campaigns, contacts, messages, suppressions } from "../../lib/db.js";
import { queueCampaign, sendMessageBatch, setQStash } from "../../lib/sending.js";
import { handleSesEvent } from "../../lib/ses-events.js";
import { describeSesSuppression, setSesClient } from "../../lib/ses.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";
import { fakeQStash, fakeSes } from "../helpers/fakes.mjs";

process.env.SENDING_ENABLED = "true";
process.env.QSTASH_TOKEN = "test";
process.env.APP_URL = "https://mail.example.com";
process.env.SESSION_SECRET = "s".repeat(40);

let testDb;
let qstash;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());
beforeEach(() => {
	qstash = fakeQStash();
	setQStash(qstash);
	setSesClient(fakeSes());
});

async function status(contact) {
	const [row] = await testDb.db.select().from(contacts).where(eq(contacts._id, contact._id));
	return row.status;
}

async function sendTo(newsletter) {
	const [campaign] = await testDb.db
		.insert(campaigns)
		.values({ newsletterId: newsletter._id, subject: "Hi", format: "markdown", markdown: "Hello" })
		.returning();
	await queueCampaign(campaign._id);
	const ids = qstash.published.flatMap(({ body }) => body.messageIds);
	qstash.published.length = 0;
	await sendMessageBatch(ids);
	return testDb.db.select().from(messages).where(eq(messages.campaignId, campaign._id));
}

function sesEvent(eventType, message, detail) {
	return {
		eventType,
		mail: { messageId: message.sesMessageId, destination: [message.email], tags: { message_id: [message._id] } },
		[eventType.toLowerCase()]: detail,
	};
}

test("a spam complaint stops that newsletter only", async () => {
	const { db } = testDb;
	const supadata = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const poof = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const inSupadata = await seedContact(db, supadata, { email: "reader@example.com" });
	const inPoof = await seedContact(db, poof, { email: "reader@example.com" });

	const [message] = await sendTo(supadata);
	await handleSesEvent(
		sesEvent("Complaint", message, { complainedRecipients: [{ emailAddress: "reader@example.com" }], complaintFeedbackType: "abuse" })
	);

	assert.equal(await status(inSupadata), "complained");
	assert.equal(await status(inPoof), "active");
	assert.equal((await db.select().from(suppressions).where(eq(suppressions.email, "reader@example.com"))).length, 0);
	const [row] = await db.select().from(contacts).where(eq(contacts._id, inSupadata._id));
	assert.ok(row.complainedAt instanceof Date);

	const poofMessages = await sendTo(poof);
	assert.equal(poofMessages.length, 1, "the other newsletter still sends to them");
	assert.equal(poofMessages[0].status, "sent");
	await assert.rejects(sendTo(supadata), /No active contacts/, "the complained newsletter doesn't");
});

test("signing up to another newsletter after a complaint works; the same newsletter stays complained", async () => {
	const { db } = testDb;
	const supadata = await seedNewsletter(db);
	const gistly = await seedNewsletter(db);
	const complained = await seedContact(db, supadata, { email: "angry@example.com", status: "complained" });
	const joined = await upsertContact({ newsletter: gistly, email: "angry@example.com", source: "api" });
	assert.equal(joined.contact.status, "active");
	const again = await upsertContact({ newsletter: supadata, email: "angry@example.com", source: "api", resubscribe: true });
	assert.equal(again.contact.status, "complained");
	assert.equal(await status(complained), "complained");
});

test("a hard bounce stops every newsletter", async () => {
	const { db } = testDb;
	const supadata = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const poof = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const inSupadata = await seedContact(db, supadata, { email: "gone@example.com" });
	const inPoof = await seedContact(db, poof, { email: "gone@example.com" });
	const [message] = await sendTo(supadata);
	await handleSesEvent(
		sesEvent("Bounce", message, { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "gone@example.com" }] })
	);
	assert.equal(await status(inSupadata), "bounced");
	assert.equal(await status(inPoof), "bounced");
	const later = await upsertContact({ newsletter: await seedNewsletter(db), email: "gone@example.com", source: "api" });
	assert.equal(later.contact.status, "bounced");
});

test("a CSV complaint marks that newsletter's contact without blocking the address elsewhere", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const other = await seedNewsletter(db);
	await importContactRows({ newsletterId: newsletter._id, rows: [{ email: "spam@example.com", status: "complained" }] });
	assert.equal((await db.select().from(suppressions).where(eq(suppressions.email, "spam@example.com"))).length, 0);
	const { contact } = await upsertContact({ newsletter: other, email: "spam@example.com", source: "api" });
	assert.equal(contact.status, "active");
});

test("the suppression list only takes bounces and manual blocks", async () => {
	await assert.rejects(testDb.db.insert(suppressions).values({ email: "x@example.com", reason: "complaint" }));
});

test("SES suppression with complaints is flagged, from the configuration set first", () => {
	assert.equal(describeSesSuppression({ configurationSetReasons: ["BOUNCE"], accountReasons: ["BOUNCE", "COMPLAINT"] }).blocksComplaints, false);
	assert.deepEqual(describeSesSuppression({ configurationSetReasons: undefined, accountReasons: ["BOUNCE", "COMPLAINT"] }), {
		reasons: ["BOUNCE", "COMPLAINT"],
		source: "account",
		blocksComplaints: true,
	});
	assert.equal(describeSesSuppression({ configurationSetReasons: [] }).blocksComplaints, false);
});
