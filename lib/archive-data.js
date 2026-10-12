import "server-only";
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { getArchiveUrls, hasArchive } from "@/lib/archive-hosts";
import { isArchiveEnabled } from "@/lib/config";
import { campaigns, contacts, getDb, newsletters } from "@/lib/db";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];
const isListed = () =>
	and(isNotNull(campaigns.archiveSlug), eq(campaigns.archiveListed, true), inArray(campaigns.status, PUBLISHED_STATUSES));
const CARD_FIELDS = {
	_id: campaigns._id,
	subject: campaigns.subject,
	previewText: campaigns.previewText,
	archiveSlug: campaigns.archiveSlug,
	archivePinned: campaigns.archivePinned,
	sentAt: campaigns.sentAt,
	startedAt: campaigns.startedAt,
	thumbnailUrl: campaigns.thumbnailUrl,
	webViews: campaigns.webViews,
};

export const getArchiveNewsletter = cache(async (slug) => {
	if (!isArchiveEnabled() || !SLUG_PATTERN.test(slug)) return null;
	const [newsletter] = await getDb()
		.select({
			_id: newsletters._id,
			name: newsletters.name,
			slug: newsletters.slug,
			imageUrl: newsletters.imageUrl,
			fromName: newsletters.fromName,
			description: newsletters.description,
			socialLinks: newsletters.socialLinks,
			author: newsletters.author,
		})
		.from(newsletters)
		.where(and(eq(newsletters.slug, slug), eq(newsletters.archiveEnabled, true)));
	return newsletter ?? null;
});

// A picture several listed issues share is the newsletter's banner, not the issue's own. Those issues
// get a generated card instead, so the archive doesn't repeat one image on every card. Unlisted
// issues don't count.
const getSharedThumbnails = cache(async (newsletterId) => {
	const rows = await getDb()
		.select({ thumbnailUrl: campaigns.thumbnailUrl })
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), isNotNull(campaigns.thumbnailUrl), isListed()))
		.groupBy(campaigns.thumbnailUrl)
		.having(sql`count(*) > 1`);
	return new Set(rows.map(({ thumbnailUrl }) => thumbnailUrl));
});

async function withOwnThumbnails(newsletterId, issues) {
	const shared = await getSharedThumbnails(String(newsletterId));
	return issues.map((issue) => (shared.has(issue.thumbnailUrl) ? { ...issue, thumbnailUrl: undefined } : issue));
}

export const getArchiveIssue = cache(async (newsletterId, postSlug) => {
	if (!ARCHIVE_SLUG_PATTERN.test(postSlug)) return null;
	const [issue] = await getDb()
		.select({
			...CARD_FIELDS,
			format: campaigns.format,
			markdown: campaigns.markdown,
			html: campaigns.html,
			source: campaigns.source,
		})
		.from(campaigns)
		.where(
			and(
				eq(campaigns.newsletterId, newsletterId),
				eq(campaigns.archiveSlug, postSlug),
				inArray(campaigns.status, PUBLISHED_STATUSES)
			)
		);
	return issue && (await withOwnThumbnails(newsletterId, [issue]))[0];
});

export async function listArchiveIssues(newsletterId, { limit = 0, excludeId } = {}) {
	const select = getDb()
		.select(CARD_FIELDS)
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), isListed(), excludeId ? ne(campaigns._id, excludeId) : undefined))
		.orderBy(sql`${campaigns.sentAt} desc nulls last`, sql`${campaigns.startedAt} desc nulls last`);
	const issues = await (limit > 0 ? select.limit(limit) : select);
	return withOwnThumbnails(newsletterId, issues);
}

// For the API: every listed issue that went out.
export async function listPublishedIssues(newsletterId) {
	return getDb()
		.select({
			_id: campaigns._id,
			subject: campaigns.subject,
			previewText: campaigns.previewText,
			archiveSlug: campaigns.archiveSlug,
			sentAt: campaigns.sentAt,
			startedAt: campaigns.startedAt,
		})
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), isListed()))
		.orderBy(sql`${campaigns.sentAt} desc nulls last`, sql`${campaigns.startedAt} desc nulls last`);
}

// Cached per render: the layout's popup and the page's own subscribe blocks show the same count.
export const countReaders = cache(async (newsletterId) => {
	const [row] = await getDb()
		.select({ count: count() })
		.from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active")));
	return row.count;
});

// Cached pages are tagged by route file, so the pattern refreshes every archive page; each
// regenerates on its next visit.
export function revalidateArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

// Unlisted issues keep their page, so only the archive switch, the slug and the send decide.
export function getIssuePageUrl({ campaign, newsletter }) {
	if (!hasArchive(newsletter) || !campaign.archiveSlug || !PUBLISHED_STATUSES.includes(campaign.status)) return null;
	return getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug);
}
