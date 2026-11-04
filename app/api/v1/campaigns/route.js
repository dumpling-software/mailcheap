import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-keys";
import { listPublishedIssues } from "@/lib/archive-data";
import { getArchiveUrls, hasArchive } from "@/lib/archive-hosts";
import { uniqueArchiveSlug } from "@/lib/archive-slugs";
import { getAppUrl } from "@/lib/config";
import { campaigns, getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { MAX_BODY_BYTES, isPlainObject, toHeaderLine } from "@/lib/validation";
import { resolveNewsletter } from "@/lib/contact-events";

const MAX_SUBJECT_LENGTH = 200;
const MAX_PREVIEW_TEXT_LENGTH = 300;
// A daily draft and a page refresh every few minutes, with room to spare.
const DRAFTS_PER_KEY = { name: "api-campaigns-create", limit: 20, window: "1 h" };
const READS_PER_KEY = { name: "api-campaigns-read", limit: 600, window: "1 h" };

function fail(status, error) {
	return NextResponse.json({ error }, { status });
}

function isOptionalString(value) {
	return value === undefined || value === null || typeof value === "string";
}

function readInput(body) {
	if (!isPlainObject(body)) return { error: "Send a JSON object" };
	const { newsletter, subject, previewText, html, markdown, archiveSlug } = body;
	if (typeof newsletter !== "string" || !newsletter.trim()) return { error: "newsletter is required" };
	if (typeof subject !== "string" || !subject.trim()) return { error: "subject is required" };
	if (toHeaderLine(subject).length > MAX_SUBJECT_LENGTH) {
		return { error: `subject must be at most ${MAX_SUBJECT_LENGTH} characters` };
	}
	if (!isOptionalString(previewText) || (previewText?.length ?? 0) > MAX_PREVIEW_TEXT_LENGTH) {
		return { error: `previewText must be a string of at most ${MAX_PREVIEW_TEXT_LENGTH} characters` };
	}
	if (!isOptionalString(html) || !isOptionalString(markdown)) {
		return { error: "html and markdown must be strings" };
	}

	const hasHtml = Boolean(html?.trim());
	const hasMarkdown = Boolean(markdown?.trim());
	if (hasHtml === hasMarkdown) return { error: "Send either html or markdown" };
	const format = hasHtml ? "html" : "markdown";
	const content = hasHtml ? html : markdown;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		return { error: `${format} must be at most ${MAX_BODY_BYTES / 1000} KB (this one is ${Math.ceil(bytes / 1000)} KB)` };
	}
	if (archiveSlug !== undefined && (typeof archiveSlug !== "string" || !ARCHIVE_SLUG_PATTERN.test(archiveSlug))) {
		return { error: "archiveSlug can only use lowercase letters, numbers and dashes (120 at most)" };
	}

	return {
		slug: newsletter.trim().toLowerCase(),
		subject: toHeaderLine(subject),
		previewText: previewText?.trim() ?? "",
		format,
		content,
		archiveSlug,
	};
}

// The issues a newsletter sent, for listing them on another site. url is the archive page, when the
// archive is on.
export async function GET(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...READS_PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many requests");

	const resolved = await resolveNewsletter(new URL(request.url).searchParams.get("newsletter") ?? "", apiKey);
	if (resolved.error) return fail(resolved.status, resolved.error);
	const { newsletter } = resolved;

	const issues = await listPublishedIssues(newsletter._id);
	const urls = hasArchive(newsletter) ? getArchiveUrls(newsletter) : null;
	return NextResponse.json({
		issues: issues.map(({ _id, subject, previewText, archiveSlug, sentAt, startedAt }) => ({
			id: String(_id),
			subject,
			previewText,
			archiveSlug,
			url: urls?.absolutePost(archiveSlug) ?? null,
			sentAt: sentAt ?? startedAt ?? null,
		})),
	});
}

export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...DRAFTS_PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many drafts");

	const input = readInput(await request.json().catch(() => null));
	if (input.error) return fail(400, input.error);

	const resolved = await resolveNewsletter(input.slug, apiKey);
	if (resolved.error) return fail(resolved.status, resolved.error);
	const { newsletter } = resolved;

	const [campaign] = await getDb()
		.insert(campaigns)
		.values({
			newsletterId: newsletter._id,
			subject: input.subject,
			previewText: input.previewText,
			format: input.format,
			[input.format]: input.content,
			thumbnailUrl: firstImageUrl({ format: input.format, html: input.content, markdown: input.content }) ?? null,
			...(input.archiveSlug && { archiveSlug: await uniqueArchiveSlug(input.archiveSlug) }),
			source: "api",
		})
		.returning();
	const id = String(campaign._id);
	return NextResponse.json(
		{ id, url: `${getAppUrl()}/campaigns/${id}`, archiveSlug: campaign.archiveSlug ?? null },
		{ status: 201 }
	);
}
