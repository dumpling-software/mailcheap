// The production path: lib/db.js over the postgres driver and the wire protocol (PGlite's socket
// server standing in for Supabase), where raw results come back as strings unless the code converts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getDb, setDb } from "../../lib/db.js";
import { fakeQStash, fakeSes } from "../helpers/fakes.mjs";

const MIGRATIONS = new URL("../../db/migrations", import.meta.url).pathname;
let pglite;
let server;

before(async () => {
	pglite = new PGlite();
	await migrate(drizzle({ client: pglite, casing: "snake_case" }), { migrationsFolder: MIGRATIONS });
	server = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1" });
	await server.start();
	const { port } = server.server.address();
	setDb(null);
	process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
	process.env.DATABASE_POOL_SIZE = "1";
});

after(async () => {
	await getDb().$client.end({ timeout: 1 });
	await server.stop();
	await pglite.close();
});

test("the app's queries work over the postgres driver", async () => {
	const { upsertContact, listNewslettersWithActiveCounts } = await import("../../lib/contacts.js");
	const { getSubscriberHistory, getEmailStats, getHourlySends } = await import("../../lib/overview-data.js");
	const { findRecentCampaigns, findSendTimes } = await import("../../lib/campaign-queries.js");
	const { campaigns, newsletters } = await import("../../lib/db.js");

	const [newsletter] = await getDb()
		.insert(newsletters)
		.values({ name: "Weekly", slug: "weekly", fromEmail: "news@example.com" })
		.returning();
	const { contact, created } = await upsertContact({ newsletter, email: "dana@example.com", source: "api" });
	assert.equal(created, true);
	assert.ok(contact.subscribedAt instanceof Date);
	assert.equal((await upsertContact({ newsletter, email: "dana@example.com", source: "api" })).created, false);

	const [row] = await listNewslettersWithActiveCounts();
	assert.equal(row.activeCount, 1);

	const [campaign] = await getDb()
		.insert(campaigns)
		.values({ newsletterId: newsletter._id, status: "scheduled", scheduledAt: new Date(Date.now() + 60_000) })
		.returning();
	const [recent] = await findRecentCampaigns(5, newsletter._id);
	assert.equal(recent._id, campaign._id);
	assert.ok(recent.scheduledAt instanceof Date);
	const [time] = await findSendTimes({ excludeId: "00000000-0000-0000-0000-000000000000" });
	assert.ok(time.at instanceof Date);

	const history = await getSubscriberHistory({ newsletterId: newsletter._id, timeZone: "Europe/Warsaw" });
	assert.equal(history.total, 1);
	assert.equal((await getEmailStats({ newsletterId: newsletter._id })).current.sent, 0);
	assert.equal((await getHourlySends({ newsletterId: newsletter._id, timeZone: "UTC" })).length, 24);
});

test("a send, its SES events, an import and an alert work over the postgres driver", async () => {
	process.env.SENDING_ENABLED = "true";
	process.env.QSTASH_TOKEN = "test";
	process.env.APP_URL = "https://mail.example.com";
	process.env.SESSION_SECRET = "s".repeat(40);
	const { queueCampaign, sendMessageBatch, setQStash } = await import("../../lib/sending.js");
	const { handleSesEvent, recordEngagement } = await import("../../lib/ses-events.js");
	const { setSesClient } = await import("../../lib/ses.js");
	const { importContactRows } = await import("../../lib/contact-import.js");
	const { sendAlert } = await import("../../lib/alerts.js");
	const { campaigns, contacts, messages, newsletters } = await import("../../lib/db.js");
	const { eq } = await import("drizzle-orm");
	const qstash = fakeQStash();
	setQStash(qstash);
	setSesClient(fakeSes());

	const [newsletter] = await getDb()
		.insert(newsletters)
		.values({ name: "Daily", slug: "daily", fromEmail: "news@example.com", postalAddress: "1 Main St", cleanup: { enabled: true } })
		.returning();
	const imported = await importContactRows({
		newsletterId: newsletter._id,
		rows: [
			{ email: "a@example.com", status: "active", subscribed_at: "2025-01-02" },
			{ email: "b@example.com", status: "active" },
			{ email: "c@example.com", status: "bounced" },
		],
	});
	assert.deepEqual(imported, { created: 3, existing: 0, invalid: 0 });

	const [campaign] = await getDb()
		.insert(campaigns)
		.values({ newsletterId: newsletter._id, subject: "Hello", format: "markdown", markdown: "Hi" })
		.returning();
	assert.equal((await queueCampaign(campaign._id)).recipients, 2);
	const ids = qstash.published.flatMap(({ body }) => body.messageIds);
	assert.equal((await sendMessageBatch(ids)).sent, 2);
	const [sent] = await getDb().select().from(campaigns).where(eq(campaigns._id, campaign._id));
	assert.equal(sent.status, "sent");
	assert.ok(sent.sentAt instanceof Date);

	const [message] = await getDb().select().from(messages).where(eq(messages._id, ids[0]));
	await handleSesEvent({ eventType: "Delivery", mail: { messageId: message.sesMessageId, destination: [message.email] } });
	await recordEngagement({ messageId: message._id, type: "Open" });
	const [reader] = await getDb().select().from(contacts).where(eq(contacts._id, message.contactId));
	assert.ok(reader.lastOpenAt instanceof Date);
	assert.equal(reader.ignoredIssues, 0);
	const [counted] = await getDb().select().from(campaigns).where(eq(campaigns._id, campaign._id));
	assert.equal(counted.stats.delivered, 1);
	assert.equal(counted.stats.opened, 1);

	await sendAlert({ key: "driver", title: "Driver", detail: "works" });
});
