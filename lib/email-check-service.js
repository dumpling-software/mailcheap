import "server-only";
import { isRateLimited } from "@/lib/rate-limit";

// Verification services, best first: verifymail.io (paid, VERIFYMAIL_API_KEY) caught every domain of the
// October 2026 bot signups, DeBounce's free disposable check all but one. Each answers for the domain, so
// one lookup covers every address there. A service that fails or is throttled hands over to the next.
const SERVICES = [
	{
		name: "verifymail",
		paid: true,
		isConfigured: () => Boolean(process.env.VERIFYMAIL_API_KEY),
		url: (domain) => `https://verifymail.io/api/${encodeURIComponent(domain)}?key=${process.env.VERIFYMAIL_API_KEY}`,
		timeout: 2000,
		// Privacy relays (Fastmail, iCloud Hide My Email) deliver, so only disposable or blocked counts.
		read: (body) => (typeof body?.disposable === "boolean" ? body.disposable || body.block === true : null),
	},
	{
		name: "debounce",
		isConfigured: () => true,
		url: (domain) => `https://disposable.debounce.io/?email=${encodeURIComponent(domain)}`,
		timeout: 1500,
		// "true" and "false" come as strings.
		read: (body) => ({ true: true, false: false })[String(body?.disposable)] ?? null,
	},
];

// Sweeps of an app's existing users share verifymail.io with signups: at most VERIFYMAIL_SWEEP_PER_DAY
// lookups a day (2,500 by default, half the Basic plan's 5,000), spaced to 8 a second, under its limit of 15.
// DeBounce can't do sweeps: it stops answering Mailcheap's server after a few hundred lookups.
const SWEEP_SPACING_MS = 125;
let nextSweepAt = 0;

async function takeSweepSlot() {
	const limit = Number(process.env.VERIFYMAIL_SWEEP_PER_DAY) || 2500;
	if (await isRateLimited({ name: "verifymail-sweep", limit, window: "1 d", key: "all" })) return false;
	const now = Date.now();
	const at = Math.max(now, nextSweepAt);
	nextSweepAt = at + SWEEP_SPACING_MS;
	if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
	return true;
}

// { verdict: "disposable" | "ok", source } from the first service that answers, or null. paid: false skips
// the services that charge per check, "sweep" uses them within the sweep budget; only names the one service
// to ask.
export async function checkWithService(domain, { paid = true, only } = {}) {
	for (const service of SERVICES) {
		if (!service.isConfigured() || (service.paid && !paid) || (only && service.name !== only)) continue;
		if (service.paid && paid === "sweep" && !(await takeSweepSlot())) continue;
		try {
			const response = await fetch(service.url(domain), { signal: AbortSignal.timeout(service.timeout) });
			if (!response.ok) throw new Error(`answered ${response.status}`);
			const disposable = service.read(await response.json());
			if (disposable === null) throw new Error("gave no verdict");
			return { verdict: disposable ? "disposable" : "ok", source: service.name };
		} catch (error) {
			console.warn(`[email-check] ${service.name} ${error.message} for ${domain}`);
		}
	}
	return null;
}
