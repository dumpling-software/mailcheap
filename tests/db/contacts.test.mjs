import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { importContactRows } from "../../lib/contact-import.js";
import { confirmContact, keepContact, listNewslettersWithActiveCounts, upsertContact } from "../../lib/contacts.js";
import { contacts, suppressions } from "../../lib/db.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

let testDb;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());

async function reload(contact) {
	const [row] = await testDb.db.select().from(contacts).where(eq(contacts._id, contact._id));
	return row;
}

test("signing up creates the contact once; signing up again finds it", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const first = await upsertContact({ newsletter, email: "dana@example.com", source: "api" });
	assert.equal(first.created, true);
	assert.equal(first.contact.status, "active");
	assert.equal(first.contact.source, "api");

	const again = await upsertContact({ newsletter, email: "dana@example.com", source: "website" });
	assert.equal(again.created, false);
	assert.equal(again.contact._id, first.contact._id);
	assert.equal(again.contact.source, "api", "the first source stays");
});

test("an unsubscribed contact comes back only with resubscribe, and a sign of life resets the count", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const contact = await seedContact(testDb.db, newsletter, { status: "unsubscribed", unsubscribedAt: new Date(), ignoredIssues: 4 });

	const kept = await upsertContact({ newsletter, email: contact.email, source: "api" });
	assert.equal(kept.contact.status, "unsubscribed");

	const back = await upsertContact({ newsletter, email: contact.email, source: "website", resubscribe: true });
	assert.equal(back.contact.status, "active");
	assert.equal(back.contact.unsubscribedAt, null);
	assert.equal(back.contact.ignoredIssues, 0);
	assert.ok(back.contact.lastEngagedAt instanceof Date);
});

test("a suppressed address joins with the suppression's status and never comes back", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	await testDb.db.insert(suppressions).values({ email: "gone@example.com", reason: "bounce" });
	const { contact } = await upsertContact({ newsletter, email: "gone@example.com", source: "api" });
	assert.equal(contact.status, "bounced");
	const again = await upsertContact({ newsletter, email: "gone@example.com", source: "api", resubscribe: true });
	assert.equal(again.contact.status, "bounced");
});

test("confirming moves a pending contact to active once", async () => {
	const newsletter = await seedNewsletter(testDb.db, { requireConfirmation: true });
	const { contact } = await upsertContact({ newsletter, email: "new@example.com", source: "website" });
	assert.equal(contact.status, "pending");
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	assert.equal((await confirmContact(reference)).confirmed, true);
	const second = await confirmContact(reference);
	assert.equal(second.confirmed, false);
	assert.equal(second.contact.status, "active");
});

test("keep sending it brings a dormant contact back, but not an unsubscribed one", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const dormant = await seedContact(testDb.db, newsletter, { status: "dormant", ignoredIssues: 9 });
	const left = await seedContact(testDb.db, newsletter, { status: "unsubscribed" });
	const kept = await keepContact({ contactId: dormant._id, newsletterId: newsletter._id });
	assert.equal(kept.status, "active");
	assert.equal(kept.ignoredIssues, 0);
	assert.equal(await keepContact({ contactId: left._id, newsletterId: newsletter._id }), null);
});

test("newsletters list their active contacts", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	await seedContact(testDb.db, newsletter);
	await seedContact(testDb.db, newsletter);
	await seedContact(testDb.db, newsletter, { status: "unsubscribed" });
	const row = (await listNewslettersWithActiveCounts()).find(({ _id }) => _id === newsletter._id);
	assert.equal(row.activeCount, 2);
});

test("an import adds contacts, keeps existing ones and only makes statuses stricter", async () => {
	const newsletter = await seedNewsletter(testDb.db);
	const existing = await seedContact(testDb.db, newsletter, { email: "old@example.com" });
	const rows = [
		{ email: "old@example.com", status: "unsubscribed" },
		{ email: "new@example.com", status: "active", open_rate: "50%" },
		{ email: "bounced@example.com", status: "bounced" },
		{ email: "not-an-email", status: "active" },
	];
	const result = await importContactRows({ newsletterId: newsletter._id, rows });
	assert.deepEqual(result, { created: 2, existing: 1, invalid: 1 });
	assert.equal((await reload(existing)).status, "unsubscribed");
	const [suppression] = await testDb.db.select().from(suppressions).where(eq(suppressions.email, "bounced@example.com"));
	assert.equal(suppression.reason, "bounce");

	const again = await importContactRows({ newsletterId: newsletter._id, rows: [{ email: "old@example.com", status: "active" }] });
	assert.deepEqual(again, { created: 0, existing: 1, invalid: 0 });
	assert.equal((await reload(existing)).status, "unsubscribed", "an import never makes a contact active again");
});
