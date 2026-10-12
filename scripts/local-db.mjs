// A local Postgres for development without Docker: PGlite (Postgres in WebAssembly) behind the Postgres
// wire protocol, with every migration applied. Data stays in .local-db/ between runs.
//   npm run db:local   then   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres npm run dev
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const port = Number(process.env.LOCAL_DB_PORT || 5433);
const dataDir = new URL("../.local-db/", import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

const db = new PGlite(dataDir);
await migrate(drizzle({ client: db, casing: "snake_case" }), {
	migrationsFolder: new URL("../db/migrations", import.meta.url).pathname,
});
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`Local Postgres on postgres://postgres:postgres@127.0.0.1:${port}/postgres (data in .local-db/)`);

async function stop() {
	await server.stop();
	await db.close();
	process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
