import "server-only";
import { eq } from "drizzle-orm";
import { campaigns, getDb } from "@/lib/db";
import { slugify } from "@/lib/slug";

export async function uniqueArchiveSlug(base) {
	for (let suffix = 1; suffix < 100; suffix += 1) {
		const slug = suffix === 1 ? base : `${base}-${suffix}`;
		const [taken] = await getDb().select({ _id: campaigns._id }).from(campaigns).where(eq(campaigns.archiveSlug, slug));
		if (!taken) return slug;
	}
	return `${base}-${Date.now()}`;
}

// Unless the API set one, the slug comes from the subject as it is when the issue goes out, so the
// /p/ page exists before the first email links to it.
export async function assignArchiveSlug({ campaign, newsletter }) {
	if (!newsletter.archiveEnabled || campaign.archiveSlug) return;
	const archiveSlug = await uniqueArchiveSlug(slugify(campaign.subject, 80) || "issue");
	await getDb().update(campaigns).set({ archiveSlug }).where(eq(campaigns._id, campaign._id));
}
