// Gives each product its template from templates/<slug>.html and .css. Products that already have
// one keep it (it may have been edited in Settings) unless --force is passed.
// usage: DATABASE_URL=… node scripts/templates/seed.mjs [--force] [slug…]
import fs from "node:fs";
import postgres from "postgres";
import { validateTemplate } from "../../lib/email-template.js";

const args = process.argv.slice(2);
const isForced = args.includes("--force");
const only = args.filter((arg) => !arg.startsWith("--"));
const directory = new URL("../../templates/", import.meta.url);
const slugs = fs
	.readdirSync(directory)
	.filter((name) => name.endsWith(".html"))
	.map((name) => name.slice(0, -".html".length))
	.filter((slug) => only.length === 0 || only.includes(slug));

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
	for (const slug of slugs) {
		const template = {
			layout: fs.readFileSync(new URL(`${slug}.html`, directory), "utf8"),
			css: fs.readFileSync(new URL(`${slug}.css`, directory), "utf8"),
		};
		const problem = validateTemplate(template);
		if (problem) throw new Error(`${slug}: ${problem}`);
		const rows = isForced
			? await sql`update newsletters set template = ${sql.json(template)}, updated_at = now() where slug = ${slug} returning slug`
			: await sql`update newsletters set template = ${sql.json(template)}, updated_at = now() where slug = ${slug} and template is null returning slug`;
		console.log(`${slug}: ${rows.length > 0 ? "set" : "kept (has one already, or no such product)"}`);
	}
} finally {
	await sql.end();
}
