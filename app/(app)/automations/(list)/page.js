import Link from "next/link";
import { connection } from "next/server";
import { ChevronRight, Workflow } from "lucide-react";
import { createAutomation } from "@/app/(app)/automations/actions";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { listAutomationsWithCounts } from "@/lib/automations/queries";
import { formatNumber } from "@/lib/format";
import { getCurrentNewsletter } from "@/lib/current-newsletter";
import { toNewsletterOptions } from "@/lib/newsletters";

export const metadata = { title: "Automations" };

export default async function AutomationsPage() {
	// Rendered per request: run counts change all the time.
	await connection();
	const { current } = await getCurrentNewsletter();
	const automations = current ? await listAutomationsWithCounts(current._id) : [];

	return (
		<>
			<HeaderPage title="Automations">
				<ButtonNewCampaign newsletters={toNewsletterOptions(current ? [current] : [])} action={createAutomation} />
			</HeaderPage>

			{automations.length === 0 ? (
				<StateEmpty icon={Workflow} title="No automations yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						Emails that go out on their own: after a signup, an event from your app, or a property change.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
					{automations.map((automation) => (
						<Link
							key={automation._id}
							href={`/automations/${automation._id}`}
							className="flex items-center gap-4 border-b border-border/60 px-4 py-3 transition-colors duration-150 last:border-b-0 hover:bg-muted/40"
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate font-medium">{automation.name}</span>
								<span className="truncate text-sm text-muted-foreground">
									{describeTrigger(automation.trigger)}
								</span>
							</div>
							<dl className="hidden items-center gap-5 text-right text-sm sm:flex">
								<Count label="In it" value={automation.counts.active + automation.counts.waiting} />
								<Count label="Completed" value={automation.counts.completed} />
								<Count label="Left" value={automation.counts.exited} />
							</dl>
							<BadgeStatus status={automation.status} />
							<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
						</Link>
					))}
				</div>
			)}
		</>
	);
}

function Count({ label, value }) {
	return (
		<div className="flex w-20 flex-col">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="font-medium tabular-nums">{formatNumber(value)}</dd>
		</div>
	);
}

function describeTrigger(trigger) {
	if (trigger?.type === "event") return `When ${trigger.name || "an event"} happens`;
	if (trigger?.type === "property_changed") {
		return `When ${trigger.property || "a property"} changes${Object.hasOwn(trigger, "to") ? ` to ${trigger.to}` : ""}`;
	}
	return "When a contact joins";
}
