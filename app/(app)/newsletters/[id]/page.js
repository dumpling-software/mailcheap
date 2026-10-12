import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import { cleanupTotalsQuery } from "@/lib/engagement";
import { isArchiveEnabled, isSendingEnabled } from "@/lib/config";
import { query } from "@/lib/db";
import { findNewsletter } from "@/lib/records";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";
import { isUuid } from "@/lib/validation";

export const metadata = { title: "Newsletter" };

export default async function NewsletterPage({ params }) {
	const { id } = await params;
	const isNew = id === "new";
	if (!isNew && !isUuid(id)) notFound();

	const [newsletter, domains, cleanupTotals] = await Promise.all([
		isNew ? null : findNewsletter(id),
		listSesDomains(),
		isNew ? null : getCleanupTotals(id),
	]);
	if (!isNew && !newsletter) notFound();

	const verifiedDomains = Array.isArray(domains)
		? domains.filter(({ verified }) => verified).map(({ domain }) => domain)
		: null;

	return (
		<>
			<HeaderPage
				title={isNew ? "New newsletter" : newsletter.name}
				backHref="/newsletters"
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
