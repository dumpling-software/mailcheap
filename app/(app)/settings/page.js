import { redirect } from "next/navigation";
import PageNewsletter from "@/components/PageNewsletter";
import { getCurrentNewsletter } from "@/lib/current-newsletter";
import { findNewsletter } from "@/lib/records";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
	const { current } = await getCurrentNewsletter();
	if (!current) redirect("/newsletters/new");
	return <PageNewsletter newsletter={await findNewsletter(current._id)} />;
}
