import { Send } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import { getIssuePageUrl } from "@/lib/archive-data";
import { findRecentCampaigns } from "@/lib/campaign-queries";
import { getCurrentNewsletter } from "@/lib/current-newsletter";
import { toNewsletterMap, toNewsletterOptions } from "@/lib/newsletters";

export const metadata = { title: "Campaigns" };

// The product picked in the sidebar: its campaigns, and New writes one for it.
export default async function CampaignsPage() {
	const { newsletters, current } = await getCurrentNewsletter();
	const campaigns = current ? await findRecentCampaigns(200, current._id) : [];
	const newslettersById = new Map(newsletters.map((newsletter) => [newsletter._id.toString(), newsletter]));
	const pageUrls = Object.fromEntries(
		campaigns
			.map((campaign) => [
				campaign._id.toString(),
				getIssuePageUrl({ campaign, newsletter: newslettersById.get(campaign.newsletterId.toString()) }),
			])
			.filter(([, url]) => url)
	);

	return (
		<>
			<HeaderPage title="Campaigns">
				<ButtonNewCampaign newsletters={toNewsletterOptions(current ? [current] : [])} />
			</HeaderPage>

			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title="No campaigns yet" />
			) : (
				<div className="animate-enter">
					<TableCampaigns
						campaigns={campaigns}
						newsletters={toNewsletterMap(newsletters)}
						hasActions
						pageUrls={pageUrls}
					/>
				</div>
			)}
		</>
	);
}
