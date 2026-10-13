import { and, count, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { getArchiveUrls, hasArchive } from "@/lib/archive-hosts";
import { findSendTimes } from "@/lib/campaign-queries";
import { isSendingEnabled } from "@/lib/config";
import { contacts, getDb, messages } from "@/lib/db";
import { messageStatsSelect } from "@/lib/message-stats";
import { findCampaign, findNewsletter } from "@/lib/records";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }) {
	const { id } = await params;
	const campaign = await findCampaign(id);
	if (!campaign) notFound();
	const newsletter = await findNewsletter(campaign.newsletterId);
	if (!newsletter) notFound();

	if (!["draft", "scheduled"].includes(campaign.status)) {
		const [providers, remainingCount] = await Promise.all([
			getProviderBreakdown(campaign._id),
			countRemaining(campaign),
		]);
		return (
			<CampaignReport
				campaign={serialize(campaign)}
				newsletter={serialize(newsletter)}
				providers={providers}
				remainingCount={remainingCount}
			/>
		);
	}

	const [audienceCount, domains, sendTimes] = await Promise.all([
		countActive(newsletter._id),
		listSesDomains(),
		getSendTimes(campaign),
	]);
	const fromDomain = newsletter.fromEmail.split("@")[1];
	const isDomainVerified =
		Array.isArray(domains) && domains.some(({ domain, verified }) => domain === fromDomain && verified);

	return (
		// Keyed by format: converting an HTML draft to Markdown starts the form over.
		<FormCampaign
			key={campaign.format}
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			audienceCount={audienceCount}
			isDomainVerified={isDomainVerified}
			isSendingEnabled={isSendingEnabled()}
			testEmail={process.env.ADMIN_EMAIL}
			sendTimes={sendTimes}
			archiveUrlBase={hasArchive(newsletter) ? getArchiveUrls(newsletter).absolutePost("") : null}
		/>
	);
}

// A newsletter's first issue borrows the times the other newsletters go out.
async function getSendTimes(campaign) {
	const own = await findSendTimes({ newsletterId: campaign.newsletterId, excludeId: campaign._id });
	const rows = own.length > 0 ? own : await findSendTimes({ excludeId: campaign._id });
	return {
		history: rows.map(({ at }) => at.toISOString()),
		taken: own.filter(({ status }) => status === "scheduled").map(({ at }) => at.toISOString()),
	};
}

// Only a send capped to the most engaged has a next step. Close enough for the dialog: contacts who
// left after receiving it make this a little low, and the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit) return 0;
	const active = await countActive(campaign.newsletterId);
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}

async function countActive(newsletterId) {
	const [row] = await getDb()
		.select({ count: count() })
		.from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active")));
	return row.count;
}

async function getProviderBreakdown(campaignId) {
	const provider = sql`coalesce(${messages.provider}, 'other')`;
	const stats = messageStatsSelect();
	const rows = await getDb()
		.select({ provider: provider.mapWith(String), ...stats })
		.from(messages)
		.where(and(eq(messages.campaignId, campaignId), eq(messages.kind, "campaign")))
		.groupBy(provider)
		.orderBy(desc(stats.sent));
	return rows.filter(({ sent }) => sent > 0);
}
