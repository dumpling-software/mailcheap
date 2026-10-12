import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.js";

export * from "../db/schema.js";

const cached = globalThis.__mailcheapDb ?? { db: null };
globalThis.__mailcheapDb = cached;

// DATABASE_URL is Supabase's transaction pooler (port 6543) on serverless hosts: it hands out a server
// connection per transaction, so prepared statements are off.
export function getDb() {
	if (cached.db) return cached.db;
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
	const client = postgres(process.env.DATABASE_URL, {
		prepare: false,
		max: Number.parseInt(process.env.DATABASE_POOL_SIZE, 10) || 5,
		connect_timeout: 10,
	});
	cached.db = drizzle({ client, schema, casing: "snake_case" });
	return cached.db;
}

// Tests run every query against an in-memory Postgres (tests/helpers/db.mjs).
export function setDb(db) {
	cached.db = db;
}

// Raw SQL results: postgres-js returns the rows, PGlite an object holding them.
export async function query(statement) {
	const result = await getDb().execute(statement);
	return Array.isArray(result) ? result : result.rows;
}

export function isUniqueViolation(error) {
	return (error?.code ?? error?.cause?.code) === "23505";
}

// Counters kept in a jsonb column ({ sent, opened, ... }) move in one atomic update, like $inc did.
export function jsonIncrement(column, deltas) {
	const entries = Object.entries(deltas).filter(([, amount]) => amount);
	if (entries.length === 0) return column;
	const pairs = entries.map(([key, amount]) => sql`${key}::text, coalesce((${column}->>${key})::int, 0) + ${amount}::int`);
	return sql`${column} || jsonb_build_object(${sql.join(pairs, sql`, `)})`;
}

// A date in raw SQL. Drizzle converts dates for columns it knows, but the postgres driver it sets up
// takes only strings as raw parameters (PGlite in tests takes both).
export function timestamp(date) {
	return date == null ? sql`null::timestamptz` : sql`${new Date(date).toISOString()}::timestamptz`;
}

// The later of the column and a date; Postgres' greatest() skips nulls, so a missing column takes the date.
export function later(column, date) {
	return sql`greatest(${column}, ${timestamp(date)})`;
}

export function earlier(column, date) {
	return sql`least(${column}, ${timestamp(date)})`;
}
