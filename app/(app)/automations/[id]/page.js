import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import FormAutomation from "@/components/FormAutomation";
import { getEnrollmentCounts, getNodeStats } from "@/lib/automations/queries";
import { isSendingEnabled } from "@/lib/config";
import { automations, getDb } from "@/lib/db";
import { findNewsletter } from "@/lib/records";
import { serialize } from "@/lib/serialize";
import { isUuid } from "@/lib/validation";

export const metadata = { title: "Automation" };

export default async function AutomationPage({ params }) {
	const { id } = await params;
	if (!isUuid(id)) notFound();
	const [automation] = await getDb().select().from(automations).where(eq(automations._id, id));
	if (!automation) notFound();
	const [newsletter, counts, nodeStats] = await Promise.all([
		findNewsletter(automation.newsletterId),
		getEnrollmentCounts(automation._id),
		getNodeStats(automation._id),
	]);

	return (
		<FormAutomation
			automation={serialize(automation)}
			newsletter={serialize(newsletter)}
			counts={counts}
			nodeStats={nodeStats}
			isSendingEnabled={isSendingEnabled()}
			testEmail={process.env.ADMIN_EMAIL}
		/>
	);
}
