import { getArchiveUrls } from "@/lib/archive-hosts";
import { isArchiveEnabled } from "@/lib/config";
import { and, eq } from "drizzle-orm";
import { campaigns, getDb, newsletters } from "@/lib/db";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Archive domains rewrite /p/slug in proxy.js; on the app's domain the link doesn't name the newsletter.
export async function GET(request, { params }) {
	const { slug } = await params;
	if (!isArchiveEnabled() || !SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });

	const [newsletter] = await getDb()
		.select({ slug: newsletters.slug })
		.from(campaigns)
		.innerJoin(newsletters, eq(newsletters._id, campaigns.newsletterId))
		.where(and(eq(campaigns.archiveSlug, slug), eq(newsletters.archiveEnabled, true)));
	if (!newsletter) return new Response("Not found", { status: 404 });

	return Response.redirect(new URL(getArchiveUrls(newsletter).post(slug), request.url), 307);
}
