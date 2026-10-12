import { defineConfig } from "drizzle-kit";

// Migrations run on the direct connection (port 5432): the transaction pooler can't hold their locks.
export default defineConfig({
	dialect: "postgresql",
	schema: "./db/schema.js",
	out: "./db/migrations",
	casing: "snake_case",
	dbCredentials: { url: process.env.DIRECT_URL || process.env.DATABASE_URL || "" },
});
