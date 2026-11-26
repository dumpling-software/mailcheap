import { and, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { getArchiveUrls, hasArchive } from "@/lib/archive-hosts";
import { findSendTimes } from "@/lib/campaign-queries";
import { isAiConfigured, isSendingEnabled } from "@/lib/config";
import { contacts, getDb, messages } from "@/lib/db";
import { messageStatsSelect } from "@/lib/message-stats";
import { findCampaign, findNewsletter } from "@/lib/records";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";
import { TOPICS, campaignTopic } from "@/lib/topics";

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

	const [audienceCounts, domains, sendTimes] = await Promise.all([
		countActiveByTopic(newsletter._id),
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
			audienceCounts={audienceCounts}
			isDomainVerified={isDomainVerified}
			isSendingEnabled={isSendingEnabled()}
			testEmail={process.env.ADMIN_EMAIL}
			sendTimes={sendTimes}
			archiveUrlBase={hasArchive(newsletter) ? getArchiveUrls(newsletter).absolutePost("") : null}
			isAiEnabled={isAiConfigured()}
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
	const active = (await countActiveByTopic(campaign.newsletterId))[campaignTopic(campaign)];
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}

// Active contacts who get each topic (the editor's topic select changes the audience).
async function countActiveByTopic(newsletterId) {
	const [row] = await getDb()
		.select(
			Object.fromEntries(
				TOPICS.map((topic) => [topic, sql`count(*) filter (where not (${topic}::text = any(${contacts.unsubscribedTopics})))`.mapWith(Number)])
			)
		)
		.from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active")));
	return row;
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
