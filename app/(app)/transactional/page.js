import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { ChevronRight, Mail, TriangleAlert } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ChartSends from "@/components/ChartSends";
import HeaderPage from "@/components/HeaderPage";
import ListDomainStatus from "@/components/ListDomainStatus";
import ListProviders from "@/components/ListProviders";
import ListStats from "@/components/ListStats";
import { SkeletonDomainList, SkeletonSends, SkeletonStats } from "@/components/SkeletonOverview";
import StateEmpty from "@/components/StateEmpty";
import SwatchChart from "@/components/SwatchChart";
import { formatNumber, formatRelative, formatSendTime } from "@/lib/format";
import { PERIOD_DAYS } from "@/lib/overview-series";
import { listSesDomains } from "@/lib/ses";
import { TIME_ZONE_COOKIE, resolveTimeZone, timeZoneLabel } from "@/lib/time-zone";
import { getTransactionalSet } from "@/lib/transactional";
import {
	getTransactionalHourly,
	getTransactionalProviders,
	getTransactionalStats,
	listTransactionalDomains,
	listTransactionalProblems,
} from "@/lib/transactional-data";
import { cn } from "@/lib/utils";

export const metadata = { title: "Transactional" };

// Email other apps send through SES (login links, notifications), for the whole account: it belongs
// to no product. Rows come from the transactional configuration set's SES events.
export default async function TransactionalPage({ searchParams }) {
	const [params, cookieStore, domains] = await Promise.all([searchParams, cookies(), listTransactionalDomains()]);
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	const domain = domains.includes(params?.domain) ? params.domain : null;
	const key = domain ?? "all";

	return (
		<>
			<HeaderPage title="Transactional" />

			{domains.length === 0 ? (
				<StateEmpty icon={Mail} title="No transactional email yet">
					<p className="max-w-md text-sm text-pretty text-muted-foreground">
						Make <code className="font-mono text-xs">{getTransactionalSet() ?? "transactional"}</code> the default
						configuration set of the domains your other apps send from, and send its events to Mailcheap&apos;s SNS
						topic. See the README.
					</p>
				</StateEmpty>
			) : (
				<div className="flex flex-col gap-8">
					<FilterDomains domains={domains} selected={domain} />

					<Section title={`Last ${PERIOD_DAYS} days`} stagger={1}>
						<div className="overflow-hidden rounded-2xl bg-card shadow-border">
							<Suspense key={`stats-${key}`} fallback={<SkeletonStats count={4} />}>
								<StatsTransactional domain={domain} />
							</Suspense>
						</div>
					</Section>

					<Section title="Today" stagger={2}>
						<Suspense key={`sends-${key}`} fallback={<SkeletonSends />}>
							<CardSends domain={domain} timeZone={timeZone} />
						</Suspense>
					</Section>

					<Section title="By inbox" stagger={3}>
						<Suspense key={`providers-${key}`} fallback={<SkeletonDomainList rows={4} />}>
							<TableProviders domain={domain} />
						</Suspense>
					</Section>

					<Section title="Problems" stagger={4}>
						<Suspense key={`problems-${key}`} fallback={<SkeletonDomainList rows={5} />}>
							<ListProblems domain={domain} />
						</Suspense>
					</Section>

					<Section title="Domains" href="/domains" stagger={5}>
						<Suspense fallback={<SkeletonDomainList rows={domains.length} />}>
							<SectionDomains domains={domain ? [domain] : domains} />
						</Suspense>
					</Section>
				</div>
			)}
		</>
	);
}

function FilterDomains({ domains, selected }) {
	const items = [{ label: "All domains", href: "/transactional", active: !selected }].concat(
		domains.map((domain) => ({
			label: domain,
			href: `/transactional?domain=${encodeURIComponent(domain)}`,
			active: domain === selected,
		}))
	);
	return (
		<nav aria-label="Domain" className="-mt-4 flex flex-wrap gap-1.5 animate-enter">
			{items.map(({ label, href, active }) => (
				<Link
					key={href}
					href={href}
					aria-current={active ? "page" : undefined}
					className={cn(
						"h-8 rounded-lg px-3 text-sm leading-8 font-medium transition-colors duration-150",
						active ? "bg-muted text-foreground" : "text-muted-foreground shadow-border hover:bg-muted/60 hover:text-foreground"
					)}
				>
					{label}
				</Link>
			))}
		</nav>
	);
}

async function StatsTransactional({ domain }) {
	const stats = await getTransactionalStats({ domain });
	return (
		<div className="animate-fade-in">
			<ListStats current={stats.current} previous={stats.previous} omit={["Opened", "Clicked"]} />
		</div>
	);
}

async function CardSends({ domain, timeZone }) {
	const hours = await getTransactionalHourly({ domain, timeZone });
	const sentToday = hours.reduce((sum, { today }) => sum + (today ?? 0), 0);
	const sentYesterday = hours.reduce((sum, { yesterday }) => sum + yesterday, 0);

	return (
		<div className="flex flex-col gap-6 rounded-2xl bg-card p-5 shadow-border animate-fade-in sm:p-6">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-medium text-muted-foreground">Emails sent per hour</h2>
					<p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="text-3xl font-semibold tracking-tight tabular-nums">{formatNumber(sentToday)}</span>
						<span className="text-sm text-muted-foreground tabular-nums">{formatNumber(sentYesterday)} yesterday</span>
					</p>
				</div>
				<ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
					<li className="flex items-center gap-2">
						<SwatchChart kind="bar" />
						Today
					</li>
					<li className="flex items-center gap-2">
						<SwatchChart kind="ghost" />
						Yesterday
					</li>
					<li>{timeZoneLabel(timeZone)}</li>
				</ul>
			</div>
			<ChartSends hours={hours} />
		</div>
	);
}

async function TableProviders({ domain }) {
	const providers = await getTransactionalProviders({ domain });
	if (providers.length === 0) return <TextNone>Nothing sent in the last {PERIOD_DAYS} days</TextNone>;
	return (
		<div className="overflow-hidden rounded-xl shadow-border animate-fade-in">
			<ListProviders providers={providers} engagement={false} />
		</div>
	);
}

const PROBLEM_LABELS = { delayed: "Delayed", bounced: "Bounced", complained: "Complaint", failed: "Rejected" };

// The latest bounces, complaints, rejects and delays, newest first.
async function ListProblems({ domain }) {
	const problems = await listTransactionalProblems({ domain });
	if (problems.length === 0) return <TextNone>No bounces, complaints or delays</TextNone>;
	return (
		<ul className="divide-y divide-border/60 overflow-hidden rounded-xl bg-card shadow-border animate-fade-in">
			{problems.map((problem) => (
				<li key={problem.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<p className="flex min-w-0 items-center gap-2 text-sm font-medium">
							<BadgeStatus status={problem.status} label={PROBLEM_LABELS[problem.status]} />
							<span className="truncate">{problem.email ?? "Unknown recipient"}</span>
						</p>
						<p className="truncate text-xs text-muted-foreground">
							{[problem.domain, problem.subject, problem.error].filter(Boolean).join(" · ")}
						</p>
					</div>
					<time
						dateTime={problem.occurredAt.toISOString()}
						title={formatSendTime(problem.occurredAt)}
						className="shrink-0 text-xs text-muted-foreground tabular-nums"
					>
						{formatRelative(problem.occurredAt)}
					</time>
				</li>
			))}
		</ul>
	);
}

async function SectionDomains({ domains }) {
	const sesDomains = await listSesDomains();
	if (sesDomains.error) {
		return (
			<p className="flex items-center gap-3 rounded-xl px-4 py-4 text-sm text-muted-foreground shadow-border animate-fade-in">
				<TriangleAlert className="size-4 shrink-0 text-amber-500" />
				<span className="truncate">SES unreachable: {sesDomains.error}</span>
			</p>
		);
	}
	const shown = sesDomains.filter((sesDomain) => domains.includes(sesDomain.domain));
	if (shown.length === 0) return <TextNone>These domains aren&apos;t SES identities</TextNone>;
	return (
		<div className="animate-fade-in">
			<ListDomainStatus domains={shown} />
		</div>
	);
}

function TextNone({ children }) {
	return (
		<p className="rounded-xl px-4 py-6 text-center text-sm text-muted-foreground shadow-border animate-fade-in">
			{children}
		</p>
	);
}

function Section({ title, href, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="flex flex-col gap-3 animate-enter">
			<h2 className="text-sm font-medium text-muted-foreground">
				{href ? (
					<Link href={href} className="group inline-flex items-center gap-1 transition-colors hover:text-foreground">
						{title}
						<ChevronRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
					</Link>
				) : (
					title
				)}
			</h2>
			{children}
		</section>
	);
}
