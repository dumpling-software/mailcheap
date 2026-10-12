import "server-only";
import { asc, eq } from "drizzle-orm";
import { campaigns, contacts, getDb, newsletters } from "@/lib/db";
import { isUuid } from "@/lib/validation";

// One row by id, or null (also for ids that aren't UUIDs, which would make Postgres throw).
async function findById(table, id) {
	if (!isUuid(String(id ?? ""))) return null;
	const [row] = await getDb().select().from(table).where(eq(table._id, id));
	return row ?? null;
}

export function findNewsletter(id) {
	return findById(newsletters, id);
}

export function findCampaign(id) {
	return findById(campaigns, id);
}

export function findContact(id) {
	return findById(contacts, id);
}

export async function findNewsletterBySlug(slug) {
	if (typeof slug !== "string" || !slug) return null;
	const [row] = await getDb().select().from(newsletters).where(eq(newsletters.slug, slug));
	return row ?? null;
}

// For pickers and lists: what lib/newsletters.js toNewsletterOptions reads, in creation order.
export function listNewsletterSummaries() {
	return getDb()
		.select({
			_id: newsletters._id,
			name: newsletters.name,
			slug: newsletters.slug,
			imageUrl: newsletters.imageUrl,
			fromEmail: newsletters.fromEmail,
			archiveEnabled: newsletters.archiveEnabled,
		})
		.from(newsletters)
		.orderBy(asc(newsletters.createdAt));
}
