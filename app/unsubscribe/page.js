import { CircleAlert, Link2Off, MailCheck, MailX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { and, eq } from "drizzle-orm";
import { contacts, getDb } from "@/lib/db";
import { findNewsletter } from "@/lib/records";
import { AUTOMATIONS } from "@/lib/topics";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

// The URL carries the unsubscribe token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Unsubscribe",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const SUBSCRIBED_STATUSES = ["active", "dormant"];
const TOPIC_NAMES = { [AUTOMATIONS]: "tips & tutorials" };

// Links in emails with a topic (lib/topics.js) leave that topic, with a second button to leave the
// whole newsletter; links without one (signup emails, and every email sent before topics) leave it all.
export default async function UnsubscribePage({ searchParams }) {
	const { token, status, scope } = await searchParams;
	const validToken = typeof token === "string" ? token : null;
	const reference = verifyUnsubscribeToken(validToken);
	const subscription = reference ? await getSubscription(reference) : null;
	const view = getView({ reference, status, scope, subscription });
	const name = subscription?.newsletterName || "this newsletter";
	const topicName = reference?.topic ? (TOPIC_NAMES[reference.topic] ?? "product updates") : null;
	const { icon: Icon, title, description } = getCopy(view, { name, topicName });
	const action = `/api/unsubscribe?token=${validToken}`;
	const hasForm = view === "confirm" || view === "error";
	const offersAll = Boolean(topicName) && (hasForm || view === "done-topic");

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			<div className="w-full max-w-sm rounded-xl bg-card p-6 text-center shadow-border sm:p-8">
				<div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<Icon className="size-5" aria-hidden="true" />
				</div>
				<h1 className="mt-4 text-lg font-semibold tracking-tight text-balance">{title}</h1>
				<p className="mt-1.5 text-sm leading-relaxed text-pretty text-muted-foreground">
					{description}
				</p>

				{hasForm && (
					<form method="post" action={action} className="mt-6">
						<input type="hidden" name="source" value="page" />
						<Button type="submit" size="lg" className="w-full">
							Unsubscribe
						</Button>
					</form>
				)}

				{offersAll && (
					<form method="post" action={action} className={hasForm ? "mt-2" : "mt-6"}>
						<input type="hidden" name="source" value="page" />
						<input type="hidden" name="scope" value="all" />
						<Button type="submit" size="lg" variant={hasForm ? "ghost" : "outline"} className="w-full">
							Unsubscribe from all {subscription?.newsletterName ?? ""} emails
						</Button>
					</form>
				)}

				{subscription?.preferencesUrl && view !== "invalid" && (
					<p className="mt-6 text-sm">
						<a
							href={subscription.preferencesUrl}
							className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
						>
							Manage all email preferences
						</a>
					</p>
				)}
			</div>
		</main>
	);
}

async function getSubscription({ contactId, newsletterId, topic }) {
	try {
		const [newsletter, [contact]] = await Promise.all([
			findNewsletter(newsletterId),
			getDb()
				.select({ status: contacts.status, unsubscribedTopics: contacts.unsubscribedTopics })
				.from(contacts)
				.where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId))),
		]);
		return {
			newsletterName: newsletter?.name,
			preferencesUrl: toLink(newsletter?.preferencesUrl),
			isSubscribed: !contact || SUBSCRIBED_STATUSES.includes(contact.status),
			isInTopic: !(topic && contact?.unsubscribedTopics?.includes(topic)),
		};
	} catch (error) {
		console.error("[unsubscribe] Could not load the subscription:", error.message);
		return { isSubscribed: true, isInTopic: true };
	}
}

// Only http(s) links: the setting is free text.
function toLink(value) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
	} catch {
		return null;
	}
}

// done-topic: left the link's topic, still on the newsletter. done: left the whole newsletter.
function getView({ reference, status, scope, subscription }) {
	if (!reference) return "invalid";
	if (status === "error") return "error";
	if (subscription?.isSubscribed === false || (status === "done" && scope !== "topic")) return "done";
	if (!reference.topic) return "confirm";
	return status === "done" || subscription?.isInTopic === false ? "done-topic" : "confirm";
}

function getCopy(view, { name, topicName }) {
	return {
		invalid: {
			icon: Link2Off,
			title: "This link doesn't work",
			description:
				"Open the unsubscribe link from the email again, or reply to the email to ask to be removed.",
		},
		confirm: topicName
			? {
					icon: MailX,
					title: `Unsubscribe from ${name} ${topicName}?`,
					description: `You'll stop receiving ${topicName}. Other emails from ${name} keep coming.`,
				}
			: {
					icon: MailX,
					title: `Unsubscribe from ${name}?`,
					description: "You'll stop receiving its emails.",
				},
		error: {
			icon: CircleAlert,
			title: "Something went wrong",
			description: `You're still subscribed to ${name}. Try again in a minute.`,
		},
		"done-topic": {
			icon: MailCheck,
			title: `You're unsubscribed from ${topicName}`,
			description: `You won't receive ${topicName} from ${name} anymore.`,
		},
		done: {
			icon: MailCheck,
			title: "You're unsubscribed",
			description: `You won't receive emails from ${name} anymore.`,
		},
	}[view];
}
