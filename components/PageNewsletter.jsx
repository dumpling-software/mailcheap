import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import { cleanupTotalsQuery } from "@/lib/engagement";
import { isArchiveEnabled, isSendingEnabled } from "@/lib/config";
import { query } from "@/lib/db";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";

// A product's one-time setup: sender, postal address, signup confirmation, welcome email, list cleanup.
// Campaigns and automations take all of it from here. Without a newsletter, it creates one.
export default async function PageNewsletter({ newsletter }) {
	const [domains, cleanupTotals] = await Promise.all([
		listSesDomains(),
		newsletter ? getCleanupTotals(newsletter._id) : null,
	]);
	const verifiedDomains = Array.isArray(domains)
		? domains.filter(({ verified }) => verified).map(({ domain }) => domain)
		: null;

	return (
		<>
			<HeaderPage
				title={newsletter ? `${newsletter.name} settings` : "New product"}
				backHref={newsletter ? undefined : "/newsletters"}
				icon={newsletter && <AvatarNewsletter newsletter={newsletter} size={32} />}
			/>
			<FormNewsletter
				newsletter={newsletter ? serialize(newsletter) : null}
				verifiedDomains={verifiedDomains}
				isSendingEnabled={isSendingEnabled()}
				isArchiveAvailable={isArchiveEnabled()}
				testEmail={process.env.ADMIN_EMAIL}
				cleanupTotals={cleanupTotals}
			/>
		</>
	);
}

async function getCleanupTotals(newsletterId) {
	const [totals] = await query(cleanupTotalsQuery(newsletterId));
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
