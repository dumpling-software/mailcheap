import "server-only";
import { revalidatePath } from "next/cache";
import { sendAlert } from "@/lib/alerts";
import { revalidateArchive } from "@/lib/archive-data";
import { getAppUrl } from "@/lib/config";
import { and, eq } from "drizzle-orm";
import { campaigns, getDb } from "@/lib/db";
import { getQStash, queueCampaign } from "@/lib/sending";
import { isUuid } from "@/lib/validation";

// QStash's free plan delays a message 7 days at most, so later sends wake up on the way and wait again.
const MAX_WAIT_MS = 6 * 24 * 60 * 60 * 1000;
// Closer than this to the scheduled time, the send starts instead of waiting again.
const START_EARLY_MS = 60 * 1000;

export async function publishScheduledSend({ campaignId, scheduledAt, now = Date.now() }) {
	const wakeAt = Math.min(scheduledAt.getTime(), now + MAX_WAIT_MS);
	await getQStash().publishJSON({
		url: `${getAppUrl()}/api/jobs/send-scheduled`,
		body: { campaignId: String(campaignId), scheduledAt: scheduledAt.toISOString() },
		notBefore: Math.floor(wakeAt / 1000),
	});
}

// Runs when QStash delivers the job. A job whose campaign was rescheduled, unscheduled, sent or
// discarded since does nothing, so changing a schedule never needs to cancel the old job.
export async function runScheduledSend({ campaignId, scheduledAt }) {
	if (!isUuid(String(campaignId)) || typeof scheduledAt !== "string") return { skipped: "invalid job" };

	const [campaign] = await getDb()
		.select({ status: campaigns.status, scheduledAt: campaigns.scheduledAt, subject: campaigns.subject })
		.from(campaigns)
		.where(eq(campaigns._id, campaignId));
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== scheduledAt) {
		return { skipped: "not scheduled for this time anymore" };
	}
	if (campaign.scheduledAt.getTime() - Date.now() > START_EARLY_MS) {
		await publishScheduledSend({ campaignId, scheduledAt: campaign.scheduledAt });
		return { waiting: true };
	}

	try {
		const result = await queueCampaign(String(campaignId));
		revalidatePath("/campaigns");
		revalidatePath(`/campaigns/${campaignId}`);
		revalidateArchive();
		return { started: true, ...result };
	} catch (error) {
		// Only a campaign still waiting goes back to draft: one that started and then paused alerts on its own.
		const reverted = await getDb()
			.update(campaigns)
			.set({ status: "draft", scheduledAt: null })
			.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "scheduled")))
			.returning({ _id: campaigns._id });
		if (reverted.length > 0) {
			await sendAlert({
				key: `scheduled-send-${campaignId}`,
				title: "Scheduled send didn't start",
				detail: `${error.message}. "${campaign.subject || "Untitled"}" is a draft again.`,
				path: `/campaigns/${campaignId}`,
				cooldownMinutes: 1,
			});
		}
		revalidatePath("/campaigns");
		return { failed: error.message };
	}
}
