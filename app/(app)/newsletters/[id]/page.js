import { notFound } from "next/navigation";
import PageNewsletter from "@/components/PageNewsletter";
import { findNewsletter } from "@/lib/records";
import { isUuid } from "@/lib/validation";

export const metadata = { title: "Settings" };

export default async function NewsletterPage({ params }) {
	const { id } = await params;
	if (id === "new") return <PageNewsletter newsletter={null} />;
	if (!isUuid(id)) notFound();
	const newsletter = await findNewsletter(id);
	if (!newsletter) notFound();
	return <PageNewsletter newsletter={newsletter} />;
}
