import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { campaigns, getDb } from "@/lib/db";

const SENT_OR_SCHEDULED = ["scheduled", "sending", "paused", "sent"];

// When the other issues went out, newest first. A schedule counts as the time picked, before and
// after it sends.
export function findSendTimes({ newsletterId, excludeId, limit = 20 }) {
	const at = sql`coalesce(${campaigns.scheduledAt}, ${campaigns.startedAt}, ${campaigns.sentAt})`;
	return getDb()
		.select({ status: campaigns.status, at: at.mapWith(campaigns.scheduledAt) })
		.from(campaigns)
		.where(
			and(
				ne(campaigns._id, excludeId),
				inArray(campaigns.status, SENT_OR_SCHEDULED),
				newsletterId ? eq(campaigns.newsletterId, newsletterId) : undefined,
				sql`${at} is not null`
			)
		)
		.orderBy(desc(at))
		.limit(limit);
}

// The fields campaign lists show: issues also carry their HTML (up to 500 KB each).
const LIST_FIELDS = {
	_id: campaigns._id,
	newsletterId: campaigns.newsletterId,
	subject: campaigns.subject,
	status: campaigns.status,
	stats: campaigns.stats,
	thumbnailUrl: campaigns.thumbnailUrl,
	archiveSlug: campaigns.archiveSlug,
	scheduledAt: campaigns.scheduledAt,
	startedAt: campaigns.startedAt,
	sentAt: campaigns.sentAt,
	updatedAt: campaigns.updatedAt,
};

// Sent issues sort by send date, scheduled ones by the time they go out (so upcoming sends lead) and
// drafts by their last edit: imported issues all share the import time as updatedAt and createdAt.
export function findRecentCampaigns(limit, newsletterId) {
	const activityAt = sql`coalesce(${campaigns.sentAt}, ${campaigns.startedAt}, ${campaigns.scheduledAt}, ${campaigns.updatedAt})`;
	return getDb()
		.select(LIST_FIELDS)
		.from(campaigns)
		.where(and(ne(campaigns.status, "canceled"), newsletterId ? eq(campaigns.newsletterId, newsletterId) : undefined))
		.orderBy(desc(activityAt), desc(campaigns._id))
		.limit(limit);
}
