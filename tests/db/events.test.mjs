import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { generateApiKey } from "../../lib/api-keys.js";
import { apiKeys, contactEvents, contacts, messages, suppressions } from "../../lib/db.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

process.env.SESSION_SECRET = "s".repeat(40);
delete process.env.SENDING_ENABLED;

let testDb;
let supadata;
let poof;
const keys = {};
before(async () => {
	testDb = await createTestDb();
	supadata = await seedNewsletter(testDb.db, { slug: "supadata" });
	poof = await seedNewsletter(testDb.db, { slug: "poof" });
	for (const [name, newsletterId] of [["all", null], ["supadata", supadata._id]]) {
		const { key, prefix, hash } = generateApiKey();
		await testDb.db.insert(apiKeys).values({ name, prefix, hash, newsletterId });
		keys[name] = key;
	}
});
after(() => testDb.close());

function request(method, path, body, key = keys.all) {
	return new Request(`https://mail.example.com${path}`, {
		method,
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function contactOf(newsletter, email) {
	const [row] = await testDb.db.select().from(contacts).where(eq(contacts.email, email));
	return row && row.newsletterId === newsletter._id ? row : null;
}

test("contact properties merge, and null removes one", async () => {
	const { POST } = await import("../../app/api/v1/contacts/route.js");
	const first = await POST(request("POST", "/api/v1/contacts", { newsletter: "supadata", email: "ann@example.com", properties: { plan: "free", name: "Ann" } }));
	assert.equal(first.status, 201);
	assert.deepEqual((await first.json()).properties, { plan: "free", name: "Ann" });

	const second = await POST(request("POST", "/api/v1/contacts", { newsletter: "supadata", email: "ann@example.com", properties: { plan: "pro", name: null } }));
	assert.equal(second.status, 200);
	assert.deepEqual((await second.json()).properties, { plan: "pro" });
	assert.deepEqual((await contactOf(supadata, "ann@example.com")).properties, { plan: "pro" });

	const bad = await POST(request("POST", "/api/v1/contacts", { newsletter: "supadata", email: "ann@example.com", properties: { "no spaces": 1 } }));
	assert.equal(bad.status, 400);
});

test("events create the contact when needed and are stored with their properties", async () => {
	const { POST } = await import("../../app/api/v1/events/route.js");
	const response = await POST(
		request("POST", "/api/v1/events", { newsletter: poof._id, email: "Bo@Example.com", name: "api_key_created", properties: { key: "k1" } })
	);
	assert.equal(response.status, 201);
	const body = await response.json();
	assert.equal(body.created, true);
	const contact = await contactOf(poof, "bo@example.com");
	assert.equal(contact.source, "api");
	const [event] = await testDb.db.select().from(contactEvents).where(eq(contactEvents.contactId, contact._id));
	assert.equal(event.name, "api_key_created");
	assert.deepEqual(event.properties, { key: "k1" });

	const again = await POST(request("POST", "/api/v1/events", { newsletter: "poof", email: "bo@example.com", name: "first_api_call" }));
	assert.equal((await again.json()).created, false);

	const old = await POST(request("POST", "/api/v1/events", { newsletter: "poof", email: "bo@example.com", name: "x", occurredAt: "2020-01-01T00:00:00Z" }));
	assert.equal(old.status, 400);
	const badName = await POST(request("POST", "/api/v1/events", { newsletter: "poof", email: "bo@example.com", name: "has space" }));
	assert.equal(badName.status, 400);
});

test("a key made for one newsletter can't touch another", async () => {
	const contactsRoute = await import("../../app/api/v1/contacts/route.js");
	const eventsRoute = await import("../../app/api/v1/events/route.js");
	const campaignsRoute = await import("../../app/api/v1/campaigns/route.js");
	const own = await contactsRoute.POST(request("POST", "/api/v1/contacts", { newsletter: "supadata", email: "c@example.com" }, keys.supadata));
	assert.equal(own.status, 201);
	const other = await contactsRoute.POST(request("POST", "/api/v1/contacts", { newsletter: "poof", email: "c@example.com" }, keys.supadata));
	assert.equal(other.status, 403);
	const event = await eventsRoute.POST(request("POST", "/api/v1/events", { newsletter: "poof", email: "c@example.com", name: "x" }, keys.supadata));
	assert.equal(event.status, 403);
	const draft = await campaignsRoute.POST(request("POST", "/api/v1/campaigns", { newsletter: "poof", subject: "x", markdown: "y" }, keys.supadata));
	assert.equal(draft.status, 403);
});

test("erasing a contact removes it, its events and its address on messages, everywhere or in one newsletter", async () => {
	const { DELETE } = await import("../../app/api/v1/contacts/route.js");
	const { db } = testDb;
	const inSupadata = await seedContact(db, supadata, { email: "gdpr@example.com" });
	const inPoof = await seedContact(db, poof, { email: "gdpr@example.com" });
	await db.insert(contactEvents).values({ newsletterId: supadata._id, contactId: inSupadata._id, name: "signed_up" });
	await db.insert(messages).values({ kind: "welcome", newsletterId: supadata._id, contactId: inSupadata._id, email: "gdpr@example.com", sentAt: new Date() });
	await db.insert(suppressions).values({ email: "gdpr@example.com", reason: "manual" });

	const scoped = await DELETE(request("DELETE", "/api/v1/contacts", { email: "gdpr@example.com" }, keys.supadata));
	assert.deepEqual(await scoped.json(), { deleted: 1 }, "a newsletter's key erases in its newsletter only");
	assert.equal((await db.select().from(contacts).where(eq(contacts._id, inPoof._id))).length, 1);
	const [message] = await db.select().from(messages).where(eq(messages.newsletterId, supadata._id));
	assert.equal(message.email, "erased@invalid");
	assert.equal(message.contactId, null);
	assert.equal((await db.select().from(contactEvents).where(eq(contactEvents.contactId, inSupadata._id))).length, 0);

	const everywhere = await DELETE(request("DELETE", "/api/v1/contacts", { email: "gdpr@example.com" }));
	assert.deepEqual(await everywhere.json(), { deleted: 1 });
	assert.equal((await db.select().from(suppressions).where(eq(suppressions.email, "gdpr@example.com"))).length, 0);
});
