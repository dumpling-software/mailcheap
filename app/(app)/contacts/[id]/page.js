import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleCheck, CircleX, Mail, MousePointerClick, UserPlus, Zap } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import TextEmpty from "@/components/TextEmpty";
import { getContactDetail } from "@/lib/contact-timeline";
import { formatDate, formatNumber, formatRelative } from "@/lib/format";
import { findContact, findNewsletter } from "@/lib/records";

export const metadata = { title: "Contact" };

export default async function ContactPage({ params }) {
	const { id } = await params;
	const contact = await findContact(id);
	if (!contact) notFound();
	const [newsletter, { memberships, runs, timeline }] = await Promise.all([
		findNewsletter(contact.newsletterId),
		getContactDetail(contact),
	]);
	const properties = Object.entries(contact.properties ?? {});

	return (
		<>
			<HeaderPage title={contact.email} backHref={`/contacts?newsletter=${contact.newsletterId}`} meta={<BadgeStatus status={contact.status} />} />

			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
				<div className="flex flex-col gap-4">
					<Card title="In this newsletter">
						<Row label="Newsletter">{newsletter?.name}</Row>
						<Row label="Source">{contact.source || <TextEmpty />}</Row>
						<Row label="Joined">{formatDate(contact.subscribedAt) ?? <TextEmpty />}</Row>
						{contact.unsubscribedAt && <Row label="Unsubscribed">{formatDate(contact.unsubscribedAt)}</Row>}
						{contact.complainedAt && <Row label="Spam report">{formatDate(contact.complainedAt)}</Row>}
						<Row label="Emails">{formatNumber(contact.stats?.sent ?? 0)} sent · {formatNumber(contact.stats?.opens ?? 0)} opened · {formatNumber(contact.stats?.clicks ?? 0)} clicked</Row>
						<Row label="Last click">{contact.lastClickAt ? formatRelative(contact.lastClickAt) : <TextEmpty />}</Row>
					</Card>

					<Card title="All newsletters">
						{memberships.map((membership) => (
							<Row key={membership._id} label={membership.newsletterName}>
								<span className="flex items-center justify-between gap-2">
									<BadgeStatus status={membership.status} />
									{membership._id !== contact._id && (
										<Link href={`/contacts/${membership._id}`} className="text-xs text-muted-foreground hover:text-foreground">
											Open
										</Link>
									)}
								</span>
							</Row>
						))}
						<p className="px-4 py-3 text-xs text-pretty text-muted-foreground">
							Unsubscribes and spam reports are per newsletter; a hard bounce stops all of them.
						</p>
					</Card>

					<Card title="Properties">
						{properties.length === 0 ? (
							<p className="px-4 py-3 text-sm text-muted-foreground">None yet. Apps set them through the API.</p>
						) : (
							properties.map(([key, value]) => (
								<Row key={key} label={<code className="font-mono text-xs">{key}</code>}>
									<span className="font-mono text-xs break-all">{String(value)}</span>
								</Row>
							))
						)}
					</Card>

					<Card title="Automations">
						{runs.length === 0 ? (
							<p className="px-4 py-3 text-sm text-muted-foreground">Not in any automation.</p>
						) : (
							runs.map((run) => (
								<Row key={run._id} label={<Link href={`/automations/${run.automationId}`} className="hover:underline">{run.automationName}</Link>}>
									<span className="flex flex-col gap-0.5">
										<BadgeStatus status={run.status === "waiting" ? "scheduled" : run.status === "exited" ? "paused" : "active"} label={describeRun(run)} />
										{run.exitReason && <span className="text-xs text-muted-foreground">{run.exitReason}</span>}
									</span>
								</Row>
							))
						)}
					</Card>
				</div>

				<Card title="Timeline">
					{timeline.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">Nothing yet.</p>
					) : (
						<ol>
							{timeline.map((item, index) => (
								<TimelineItem key={`${item.type}-${index}`} item={item} />
							))}
						</ol>
					)}
				</Card>
			</div>
		</>
	);
}

function describeRun(run) {
	if (run.status === "waiting") return `Waiting at ${run.currentNodeId} until ${formatDate(run.nextRunAt)}`;
	if (run.status === "active") return `At ${run.currentNodeId}`;
	if (run.status === "completed") return "Completed";
	return "Left early";
}

function TimelineItem({ item }) {
	const { icon: Icon, title, detail } = describeItem(item);
	return (
		<li className="flex gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
			<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-sm">{title}</span>
				{detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
			</div>
			<time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={new Date(item.at).toISOString()}>
				{formatRelative(item.at)}
			</time>
		</li>
	);
}

function describeItem(item) {
	if (item.type === "event") {
		const properties = Object.entries(item.properties ?? {});
		return {
			icon: Zap,
			title: <code className="font-mono text-[13px]">{item.name}</code>,
			detail: properties.length ? properties.map(([key, value]) => `${key}: ${value}`).join(" · ") : null,
		};
	}
	if (item.type === "email") {
		const name =
			item.kind === "automation"
				? `${item.automationName ?? "Automation"} · ${item.nodeId}`
				: item.kind === "campaign" || item.kind === "last-chance"
					? (item.campaignSubject ?? "Campaign")
					: `${item.kind.charAt(0).toUpperCase()}${item.kind.slice(1)} email`;
		const engagement = [item.openedAt && "opened", item.clickedAt && "clicked"].filter(Boolean).join(", ");
		return {
			icon: item.clickedAt ? MousePointerClick : Mail,
			title: name,
			detail: [item.kind === "last-chance" ? "last-chance email" : null, item.status, engagement].filter(Boolean).join(" · "),
		};
	}
	if (item.type === "enrolled") return { icon: UserPlus, title: `Started ${item.automationName}` };
	if (item.type === "completed") return { icon: CircleCheck, title: `Completed ${item.automationName}` };
	return { icon: CircleX, title: `Left ${item.automationName}`, detail: item.reason };
}

function Card({ title, children }) {
	return (
		<section className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
			<h2 className="border-b border-border/60 px-4 py-3 text-sm font-medium">{title}</h2>
			<div className="divide-y divide-border/60">{children}</div>
		</section>
	);
}

function Row({ label, children }) {
	return (
		<div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 text-sm">
			<span className="truncate text-muted-foreground">{label}</span>
			<span className="min-w-0">{children}</span>
		</div>
	);
}
