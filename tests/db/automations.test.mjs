import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { onContactCreated, onEvent } from "../../lib/automations/hooks.js";
import { checkAutomationHealth, enroll, processEnrollment, runDue } from "../../lib/automations/run.js";
import { recordEvent } from "../../lib/contact-events.js";
import { automations, contacts, enrollments, messages } from "../../lib/db.js";
import { sendAutomationEmail } from "../../lib/sending.js";
import { setSesClient } from "../../lib/ses.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";
import { fakeSes } from "../helpers/fakes.mjs";

process.env.SENDING_ENABLED = "true";
process.env.APP_URL = "https://mail.example.com";
process.env.SESSION_SECRET = "s".repeat(40);

const DAY = 24 * 60 * 60 * 1000;
let testDb;
let ses;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());
beforeEach(() => {
	process.env.SENDING_ENABLED = "true";
	ses = fakeSes();
	setSesClient(ses);
});

const ONBOARDING = {
	name: "Onboarding nudge",
	status: "active",
	trigger: { type: "event", name: "api_key_created" },
	exitWhen: { has_event: "first_api_call" },
	nodes: {
		start: { type: "wait_until", condition: { has_event: "first_api_call" }, timeout: "7d", met: "end", timeout_next: "help" },
		help: { type: "send", subject: "Need a hand getting started?", markdown: "Hi! I noticed you haven't made your first API call yet.", next: "wait2" },
		wait2: { type: "wait", duration: "4d", next: "check" },
		check: { type: "branch", condition: { not_has_event: "first_api_call" }, yes: "help2", no: "end" },
		help2: { type: "send", subject: "Quick question", markdown: "Anything blocking you?", next: "end" },
		end: { type: "exit" },
	},
};

async function setup(definition = ONBOARDING, contactValues = {}) {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db, { postalAddress: "1 Main St" });
	const [automation] = await db.insert(automations).values({ newsletterId: newsletter._id, ...definition }).returning();
	const contact = await seedContact(db, newsletter, contactValues);
	return { newsletter, automation, contact };
}

async function enrollmentOf(automation, contact) {
	const [row] = await testDb.db
		.select()
		.from(enrollments)
		.where(and(eq(enrollments.automationId, automation._id), eq(enrollments.contactId, contact._id)));
	return row;
}

async function sentNodes(automation) {
	const rows = await testDb.db.select().from(messages).where(eq(messages.automationId, automation._id));
	return rows.filter(({ sentAt }) => sentAt).map(({ nodeId }) => nodeId);
}

async function event(newsletter, contact, name, occurredAt = new Date()) {
	const recorded = await recordEvent({ newsletter, contact, name, occurredAt });
	return onEvent({ newsletter, contact, event: recorded });
}

test("the reference automation: no API call for a week, the help email, then the second one", async () => {
	const { newsletter, automation, contact } = await setup();
	await event(newsletter, contact, "api_key_created");
	let run = await enrollmentOf(automation, contact);
	assert.equal(run.status, "waiting");
	assert.equal(run.currentNodeId, "start");
	assert.deepEqual(run.triggerEvent, { name: "api_key_created", properties: {} });
	assert.ok(run.nextRunAt.getTime() > Date.now() + 6.9 * DAY);

	assert.equal((await runDue()).processed, 0, "nothing is due yet");
	await runDue({ now: new Date(Date.now() + 7 * DAY + 1000) });
	run = await enrollmentOf(automation, contact);
	assert.deepEqual(await sentNodes(automation), ["help"]);
	assert.equal(run.status, "waiting");
	assert.equal(run.currentNodeId, "wait2");
	assert.match(ses.sent[0].Content.Simple.Subject.Data, /Need a hand/);
	assert.match(ses.sent[0].Content.Simple.Body.Html.Data, /unsubscribe\?token=/);

	await runDue({ now: new Date(Date.now() + 11 * DAY + 2000) });
	run = await enrollmentOf(automation, contact);
	assert.deepEqual((await sentNodes(automation)).toSorted(), ["help", "help2"]);
	assert.equal(run.status, "completed");
	assert.ok(run.history.some(({ nodeId, outcome }) => nodeId === "check" && outcome === "yes"));
	const [reader] = await testDb.db.select().from(contacts).where(eq(contacts._id, contact._id));
	assert.equal(reader.stats.sent, 2);
	assert.equal(reader.ignoredIssues ?? 0, 0, "automation emails don't count toward list cleanup");
});

test("the event the run waits for ends it right away, with no email", async () => {
	const { newsletter, automation, contact } = await setup();
	await event(newsletter, contact, "api_key_created");
	await event(newsletter, contact, "first_api_call");
	const run = await enrollmentOf(automation, contact);
	assert.equal(run.status, "exited");
	assert.equal(run.exitReason, "exit condition");
	assert.deepEqual(await sentNodes(automation), []);
});

test("a run that wakes before its time keeps waiting until then", async () => {
	const { newsletter, automation, contact } = await setup();
	await event(newsletter, contact, "api_key_created");
	const before = await enrollmentOf(automation, contact);
	await event(newsletter, contact, "something_else");
	const after = await enrollmentOf(automation, contact);
	assert.equal(after.status, "waiting");
	assert.equal(after.nextRunAt.getTime(), before.nextRunAt.getTime());
});

test("contact_added sends at once; nobody goes through twice unless the automation allows it", async () => {
	const welcome = {
		name: "Welcome",
		status: "active",
		trigger: { type: "contact_added" },
		nodes: { start: { type: "send", subject: "Welcome", markdown: "Hello!" } },
	};
	const { newsletter, automation, contact } = await setup(welcome);
	await onContactCreated({ newsletter, contact });
	assert.equal((await enrollmentOf(automation, contact)).status, "completed");
	assert.deepEqual(await sentNodes(automation), ["start"]);

	await onContactCreated({ newsletter, contact });
	assert.equal(ses.sent.length, 1, "no second run");
	await testDb.db.update(automations).set({ allowReentry: true }).where(eq(automations._id, automation._id));
	const [reentering] = await testDb.db.select().from(automations).where(eq(automations._id, automation._id));
	assert.ok(await enroll({ automation: reentering, contact }), "with re-entry, a finished contact can start again");
	assert.equal(await enroll({ automation: reentering, contact }), null, "but never while a run is live");
});

test("a send node never sends twice, however often a job retries", async () => {
	const { automation, contact, newsletter } = await setup();
	const run = await enroll({ automation, contact });
	const first = await sendAutomationEmail({ automation, enrollment: run, nodeId: "help", contact, newsletter });
	const second = await sendAutomationEmail({ automation, enrollment: run, nodeId: "help", contact, newsletter });
	assert.equal(first.status, "sent");
	assert.equal(second.status, "already");
	assert.equal(ses.sent.length, 1);

	await testDb.db.update(enrollments).set({ currentNodeId: "help2", nextRunAt: new Date(0) }).where(eq(enrollments._id, run._id));
	const [a, b] = await Promise.all([processEnrollment(run._id, { due: true }), processEnrollment(run._id, { due: true })]);
	assert.ok(a.skipped || b.skipped, "a second job finds the run taken");
	assert.equal(ses.sent.length, 2);
});

test("a contact who unsubscribes in the middle leaves before the next email", async () => {
	const { newsletter, automation, contact } = await setup();
	await event(newsletter, contact, "api_key_created");
	await testDb.db.update(contacts).set({ status: "unsubscribed" }).where(eq(contacts._id, contact._id));
	await runDue({ now: new Date(Date.now() + 8 * DAY) });
	const run = await enrollmentOf(automation, contact);
	assert.equal(run.status, "exited");
	assert.equal(run.exitReason, "contact unsubscribed");
	assert.deepEqual(await sentNodes(automation), []);
});

test("with sending off, a run holds at its send node and goes on once it's back on", async () => {
	const { automation, contact } = await setup();
	const run = await enroll({ automation, contact });
	await testDb.db.update(enrollments).set({ currentNodeId: "help" }).where(eq(enrollments._id, run._id));
	process.env.SENDING_ENABLED = "false";
	assert.equal((await processEnrollment(run._id)).retry, true);
	const held = await enrollmentOf(automation, contact);
	assert.equal(held.currentNodeId, "help");
	assert.ok(held.nextRunAt > new Date());

	process.env.SENDING_ENABLED = "true";
	await processEnrollment(run._id);
	assert.deepEqual(await sentNodes(automation), ["help"]);
});

test("a paused automation holds its runs; a deleted node ends them", async () => {
	const { automation, contact } = await setup();
	const run = await enroll({ automation, contact });
	await testDb.db.update(automations).set({ status: "paused" }).where(eq(automations._id, automation._id));
	assert.equal((await processEnrollment(run._id)).held, true);
	assert.equal((await enrollmentOf(automation, contact)).status, "active");

	await testDb.db.update(automations).set({ status: "active" }).where(eq(automations._id, automation._id));
	await testDb.db.update(enrollments).set({ currentNodeId: "removed" }).where(eq(enrollments._id, run._id));
	await processEnrollment(run._id);
	const ended = await enrollmentOf(automation, contact);
	assert.equal(ended.status, "exited");
	assert.equal(ended.exitReason, "node removed");
});

test("an automation whose emails bounce too often pauses itself", async () => {
	const { automation, newsletter } = await setup();
	const rows = Array.from({ length: 120 }, (_, index) => ({
		kind: "automation",
		automationId: automation._id,
		nodeId: "help",
		newsletterId: newsletter._id,
		email: `r${index}@example.com`,
		sentAt: new Date(),
		...(index < 5 && { bouncedAt: new Date() }),
	}));
	await testDb.db.insert(messages).values(rows);
	assert.equal(await checkAutomationHealth(automation._id), "bounce rate");
	const [paused] = await testDb.db.select().from(automations).where(eq(automations._id, automation._id));
	assert.equal(paused.status, "paused");
	assert.match(paused.pausedReason, /bounce rate/);
});
