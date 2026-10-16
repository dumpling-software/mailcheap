// Email other apps send through SES SMTP: one row per message, whatever order its events arrive in.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { contacts, events, suppressions, transactionalMessages } from "../../lib/db.js";
import { handleSesEvent } from "../../lib/ses-events.js";
import {
	getTransactionalHourly,
	getTransactionalProviders,
	getTransactionalStats,
	listTransactionalDomains,
	listTransactionalProblems,
} from "../../lib/transactional-data.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

let testDb;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());
beforeEach(async () => {
	await testDb.db.delete(transactionalMessages);
});

let counter = 0;
function mail({ to = "reader@gmail.com", domain = "notifications.gist.ly", sentAt = "2026-10-04T10:00:00.000Z", id } = {}) {
	return {
		timestamp: sentAt,
		messageId: id ?? `transactional-${++counter}`,
		source: `noreply@${domain}`,
		destination: [to],
		commonHeaders: { subject: "Your login link" },
		tags: { "ses:configuration-set": ["transactional"], "ses:from-domain": [domain] },
	};
}

const delivery = (m) => ({ eventType: "Delivery", mail: m, delivery: { timestamp: "2026-10-04T10:00:03.000Z" } });
const send = (m) => ({ eventType: "Send", mail: m, send: {} });

async function rowOf(m) {
	const [row] = await testDb.db
		.select()
		.from(transactionalMessages)
		.where(eq(transactionalMessages.sesMessageId, m.messageId));
	return row;
}

test("send then delivery, or delivery then send, end in the same row; replays change nothing", async () => {
	const first = mail();
	const second = mail();
	await handleSesEvent(send(first));
	await handleSesEvent(delivery(first));
	await handleSesEvent(delivery(second));
	await handleSesEvent(send(second));
	await handleSesEvent(delivery(second));

	for (const m of [first, second]) {
		const row = await rowOf(m);
		assert.equal(row.status, "delivered");
		assert.equal(row.domain, "notifications.gist.ly");
		assert.equal(row.provider, "gmail");
		assert.equal(row.subject, "Your login link");
		assert.deepEqual(row.sentAt, new Date("2026-10-04T10:00:00.000Z"));
		assert.deepEqual(row.deliveredAt, new Date("2026-10-04T10:00:03.000Z"));
	}
	const all = await testDb.db.select().from(transactionalMessages);
	assert.equal(all.length, 2);
});

test("a hard bounce marks the row and suppresses the address for newsletters too", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const contact = await seedContact(testDb.db, newsletter, { email: "gone@example.com" });
	const m = mail({ to: "gone@example.com" });
	await handleSesEvent({
		eventType: "Bounce",
		mail: m,
		bounce: {
			bounceType: "Permanent",
			bounceSubType: "NoEmail",
			bouncedRecipients: [{ emailAddress: "gone@example.com" }],
		},
	});
	// A late delivery delay can't make a bounce look better.
	await handleSesEvent({ eventType: "DeliveryDelay", mail: m, deliveryDelay: {} });

	const row = await rowOf(m);
	assert.equal(row.status, "bounced");
	assert.ok(row.bouncedAt);
	assert.match(row.error, /Hard bounce: NoEmail/);
	const [suppressed] = await testDb.db.select().from(suppressions).where(eq(suppressions.email, "gone@example.com"));
	assert.equal(suppressed.reason, "bounce");
	const [after] = await testDb.db.select().from(contacts).where(eq(contacts._id, contact._id));
	assert.equal(after.status, "bounced");
});

test("a complaint about a transactional email changes no contact and stores no event", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const contact = await seedContact(testDb.db, newsletter, { email: "annoyed@example.com" });
	const m = mail({ to: "annoyed@example.com" });
	await handleSesEvent(delivery(m));
	await handleSesEvent({
		eventType: "Complaint",
		mail: m,
		complaint: { complainedRecipients: [{ emailAddress: "annoyed@example.com" }], complaintFeedbackType: "abuse" },
	});

	assert.equal((await rowOf(m)).status, "complained");
	const [after] = await testDb.db.select().from(contacts).where(eq(contacts._id, contact._id));
	assert.equal(after.status, contact.status);
	const stored = await testDb.db.select().from(events).where(eq(events.sesMessageId, m.messageId));
	assert.equal(stored.length, 0);
});

test("stats, hourly sends, providers and problems, by domain", async () => {
	const now = new Date("2026-10-04T12:00:00.000Z");
	const gist = mail({ sentAt: "2026-10-04T10:15:00.000Z" });
	const actionize = mail({ domain: "actionize.ai", to: "someone@outlook.com", sentAt: "2026-10-04T11:15:00.000Z" });
	const old = mail({ sentAt: "2026-08-20T10:00:00.000Z" });
	const rejected = mail({ domain: "actionize.ai", sentAt: "2026-10-03T08:00:00.000Z" });
	await handleSesEvent(delivery(gist));
	await handleSesEvent(send(actionize));
	await handleSesEvent(delivery(old));
	await handleSesEvent({ eventType: "Reject", mail: rejected, reject: { reason: "Bad content" } });

	assert.deepEqual(await listTransactionalDomains(), ["actionize.ai", "notifications.gist.ly"]);

	const all = await getTransactionalStats({ now });
	assert.equal(all.current.sent, 3);
	assert.equal(all.current.delivered, 1);
	assert.equal(all.current.failed, 1);
	assert.equal(all.previous.sent, 1);

	const actionizeOnly = await getTransactionalStats({ domain: "actionize.ai", now });
	assert.equal(actionizeOnly.current.sent, 2);
	assert.equal(actionizeOnly.previous.sent, 0);

	const hours = await getTransactionalHourly({ timeZone: "UTC", now });
	assert.equal(hours[10].today, 1);
	assert.equal(hours[11].today, 1);
	assert.equal(hours[13].today, null);

	const providers = await getTransactionalProviders({ now });
	assert.deepEqual(
		providers.map(({ provider, sent }) => [provider, sent]).sort(),
		[["gmail", 2], ["outlook", 1]]
	);

	const problems = await listTransactionalProblems({});
	assert.equal(problems.length, 1);
	assert.equal(problems[0].status, "failed");
	assert.match(problems[0].error, /Rejected by SES: Bad content/);
});
