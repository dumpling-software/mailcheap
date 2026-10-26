import "server-only";

// Verification services, best first: verifymail.io (paid, VERIFYMAIL_API_KEY) caught every domain of the
// October 2026 bot signups, DeBounce's free disposable check all but one. Each answers for the domain, so
// one lookup covers every address there. A service that fails or is throttled hands over to the next.
const SERVICES = [
	{
		name: "verifymail",
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

// { verdict: "disposable" | "ok", source } from the first service that answers, or null.
export async function checkWithService(domain) {
	for (const service of SERVICES) {
		if (!service.isConfigured()) continue;
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
