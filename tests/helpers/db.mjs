import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../db/schema.js";
import { setDb } from "../../lib/db.js";

const MIGRATIONS = new URL("../../db/migrations", import.meta.url).pathname;

// A fresh in-memory Postgres with every migration applied, installed as the app's database.
export async function createTestDb() {
	const client = new PGlite();
	const db = drizzle({ client, schema, casing: "snake_case" });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	setDb(db);
	return { db, client, close: () => client.close() };
}

export async function seedNewsletter(db, values = {}) {
	const [newsletter] = await db
		.insert(schema.newsletters)
		.values({ name: "Weekly", slug: `weekly-${Math.random().toString(36).slice(2, 8)}`, fromEmail: "news@example.com", ...values })
		.returning();
	return newsletter;
}

export async function seedContact(db, newsletter, values = {}) {
	const [contact] = await db
		.insert(schema.contacts)
		.values({ newsletterId: newsletter._id, email: `reader-${Math.random().toString(36).slice(2, 8)}@example.com`, ...values })
		.returning();
	return contact;
}
