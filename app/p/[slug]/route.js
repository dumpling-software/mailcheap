import { getArchiveUrls } from "@/lib/archive-hosts";
import { isArchiveEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Archive domains rewrite /p/slug in proxy.js; on the app's domain the link doesn't name the newsletter.
export async function GET(request, { params }) {
	const { slug } = await params;
	if (!isArchiveEnabled() || !SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });

	await connectDb();
	const campaign = await Campaign.findOne({ archiveSlug: slug }).select("newsletterId").lean();
	const newsletter =
		campaign && (await Newsletter.findOne({ _id: campaign.newsletterId, archiveEnabled: true }).select("slug").lean());
	if (!newsletter) return new Response("Not found", { status: 404 });

	return Response.redirect(new URL(getArchiveUrls(newsletter).post(slug), request.url), 307);
}
