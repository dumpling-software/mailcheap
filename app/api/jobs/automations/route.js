import { NextResponse } from "next/server";
import { runDue } from "@/lib/automations/run";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Leaves time to finish the run in progress before the platform stops the function.
const TIME_BUDGET_MS = 240_000;

// A QStash schedule calls this every 5 minutes (see the README): it moves every automation run whose
// wait is over. Runs it doesn't get to stay due for the next call. Events and signups move their own
// runs right away, without waiting for this.
async function handleAutomations() {
	const deadline = Date.now() + TIME_BUDGET_MS;
	const totals = { processed: 0, sent: 0, failed: 0 };
	for (;;) {
		const batch = await runDue({ limit: 200, deadline });
		for (const key of Object.keys(totals)) totals[key] += batch[key];
		if (!batch.more || Date.now() > deadline) break;
	}
	if (totals.processed > 0) console.info(`[automations] ${JSON.stringify(totals)}`);
	return NextResponse.json(totals);
}

export const POST = withQStashSignature(handleAutomations);
