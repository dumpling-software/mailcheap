import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { campaigns, contacts, messages } from "../../lib/db.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

let testDb;
before(async () => {
	testDb = await createTestDb();
});
after(() => testDb.close());

test("rows come back camelCase with an _id, nested stats and real dates", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const [campaign] = await db.insert(campaigns).values({ newsletterId: newsletter._id }).returning();
	assert.match(campaign._id, /^[0-9a-f-]{36}$/);
	assert.equal(campaign.stats.sent, 0);
	assert.equal(campaign.lastChance.dormant, 0);
	assert.ok(campaign.createdAt instanceof Date);
	assert.equal(campaign.archiveSlug, null);
});

test("one campaign email per contact, but any number of other kinds", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const contact = await seedContact(db, newsletter);
	const [campaign] = await db.insert(campaigns).values({ newsletterId: newsletter._id }).returning();
	const row = { kind: "campaign", campaignId: campaign._id, newsletterId: newsletter._id, contactId: contact._id, email: contact.email };
	await db.insert(messages).values(row);
	await assert.rejects(db.insert(messages).values(row), (error) => (error.code ?? error.cause?.code) === "23505");
	await db.insert(messages).values({ ...row, kind: "last-chance" });
	await db.insert(messages).values({ ...row, kind: "test" });
	await db.insert(messages).values({ ...row, kind: "test" });
});

test("updated_at moves on raw updates too", async () => {
	const { db } = testDb;
	const newsletter = await seedNewsletter(db);
	const contact = await seedContact(db, newsletter);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await db.execute(sql`update contacts set status = 'dormant' where id = ${contact._id}`);
	const [updated] = await db.select().from(contacts).where(eq(contacts._id, contact._id));
	assert.ok(updated.updatedAt > contact.updatedAt);
});
