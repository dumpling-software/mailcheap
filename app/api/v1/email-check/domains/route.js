import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-keys";
import { checkDomains } from "@/lib/email-check";
import { isRateLimited } from "@/lib/rate-limit";
import { isPlainObject } from "@/lib/validation";

const MAX_DOMAINS = 1000;
const PER_KEY = { name: "api-email-check-domains-key", limit: 600, window: "1 h" };
const DOMAIN_PATTERN = /^[a-z0-9.-]{1,253}$/;

function fail(status, error) {
	return NextResponse.json({ error }, { status });
}

// { domains: [...], verifymail?: true } → { results: { [domain]: { verdict, source } | null }, pending }, to
// sweep an app's existing users. verdict is ok, disposable, no_mail_server, blocked or allowed; null is still
// being looked up, so call again for those. verifymail.io is off unless asked, to keep its quota for signups.
export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many checks, try again later");

	const body = await request.json().catch(() => null);
	if (!isPlainObject(body) || !Array.isArray(body.domains)) return fail(400, "Send { domains: [...] }");
	if (body.domains.length > MAX_DOMAINS) return fail(400, `At most ${MAX_DOMAINS} domains per call`);
	const domains = [...new Set(body.domains.map((domain) => String(domain).trim().toLowerCase()))].filter((domain) =>
		DOMAIN_PATTERN.test(domain)
	);
	const results = await checkDomains(domains, { paid: body.verifymail === true, deadline: Date.now() + 20_000 });
	const pending = Object.values(results).filter((result) => !result).length;
	return NextResponse.json({ results, pending });
}
