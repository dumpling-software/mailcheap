// Applies db/migrations on deploy (Railway's pre-deploy command), with runtime dependencies only:
// drizzle-kit is a dev dependency and isn't in the production image. Uses DIRECT_URL (Supabase's
// direct or session connection) when set: migrations need a session, not the transaction pooler.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
	console.error("[migrate] Set DIRECT_URL or DATABASE_URL");
	process.exit(1);
}
const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
	await migrate(drizzle({ client, casing: "snake_case" }), {
		migrationsFolder: new URL("../db/migrations", import.meta.url).pathname,
	});
	console.log("[migrate] Database is up to date");
} finally {
	await client.end({ timeout: 5 });
}
