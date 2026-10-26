import "server-only";
import { Resolver } from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";
import {
	findRule,
	getEmailDomain,
	getVerdictExpiry,
	isListed,
	parseDomainList,
	toCheckResult,
} from "@/lib/email-check-rules";
import { checkWithService } from "@/lib/email-check-service";
import { contacts, emailDomainChecks, emailRules, getDb, query, timestamp } from "@/lib/db";
import { normalizeEmail } from "@/lib/validation";

// Two community lists of disposable domains, refreshed daily. Signups go on without them when GitHub is down.
const LIST_URLS = [
	"https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt",
	"https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf",
];
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const RULES_TTL_MS = 30 * 1000;

// Signup forms wait for these lookups, so each gives up within seconds.
const resolver = new Resolver({ timeout: 2000, tries: 2 });
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

const cached = globalThis.__mailcheapEmailCheck ?? { list: null, listAt: 0, listLoading: null, rules: null, rulesAt: 0 };
globalThis.__mailcheapEmailCheck = cached;

async function loadList() {
	if (cached.list && Date.now() - cached.listAt < LIST_TTL_MS) return cached.list;
	cached.listLoading ??= Promise.all(
		LIST_URLS.map(async (url) => {
			const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
			return response.text();
		})
	)
		.then((texts) => {
			cached.list = parseDomainList(texts.join("\n"));
			cached.listAt = Date.now();
		})
		.catch((error) => {
			console.error("[email-check] Could not load the disposable list:", error.message);
			// Try again in an hour, not on every signup.
			cached.listAt = Date.now() - LIST_TTL_MS + 60 * 60 * 1000;
		})
		.finally(() => {
			cached.listLoading = null;
		});
	await cached.listLoading;
	return cached.list ?? new Set();
}

export async function listEmailRules() {
	return getDb().select().from(emailRules).orderBy(emailRules.value);
}

async function loadRules() {
	if (cached.rules && Date.now() - cached.rulesAt < RULES_TTL_MS) return cached.rules;
	cached.rules = await listEmailRules();
	cached.rulesAt = Date.now();
	return cached.rules;
}

// The Email checks page edits rules: the next check reads them again.
export function forgetEmailRules() {
	cached.rules = null;
}

// { verdict, source } for a domain, or null when nothing could tell.
async function lookUpMailServer(domain) {
	try {
		const records = await resolver.resolveMx(domain);
		if (records.some(({ exchange }) => exchange && exchange !== ".")) return { verdict: "ok", source: "dns" };
		return { verdict: "no_mail_server", source: "dns" };
	} catch (error) {
		if (!NO_RECORD.has(error.code)) return null;
	}
	// Without MX, mail goes to the domain's own address (RFC 5321).
	try {
		const addresses = await resolver.resolve4(domain);
		return { verdict: addresses.length > 0 ? "ok" : "no_mail_server", source: "dns" };
	} catch (error) {
		return NO_RECORD.has(error.code) ? { verdict: "no_mail_server", source: "dns" } : null;
	}
}

async function findDomainCheck(domain, now) {
	const [row] = await getDb().select().from(emailDomainChecks).where(eq(emailDomainChecks.domain, domain));
	return row && row.expiresAt > now ? row : null;
}

async function saveDomainCheck(domain, { verdict, source }, now) {
	const expiresAt = getVerdictExpiry(verdict, now);
	await query(sql`
		insert into ${emailDomainChecks} (domain, verdict, source, expires_at)
		values (${domain}, ${verdict}, ${source}, ${timestamp(expiresAt)})
		on conflict (domain) do update set verdict = excluded.verdict, source = excluded.source, expires_at = excluded.expires_at`);
}

// Tests swap these for offline ones (setEmailCheckLookups).
const NETWORK_LOOKUPS = { loadList, checkWithService, lookUpMailServer };
let lookups = NETWORK_LOOKUPS;

export function setEmailCheckLookups(overrides) {
	lookups = overrides ? { ...NETWORK_LOOKUPS, ...overrides } : NETWORK_LOOKUPS;
	cached.rules = null;
}

// The domain's verdict: the community list first (free and instant), then the verification service, then
// whether it has a mail server at all. Saved, so a domain is looked up once per VERDICT_DAYS.
async function checkDomain(domain, now) {
	const saved = await findDomainCheck(domain, now);
	if (saved) return { verdict: saved.verdict, source: saved.source };

	let found = isListed(domain, await lookups.loadList()) ? { verdict: "disposable", source: "list" } : null;
	found ??= await lookups.checkWithService(domain);
	if (!found || found.verdict === "ok") found = (await lookups.lookUpMailServer(domain)) ?? found;
	if (!found) return null;
	await saveDomainCheck(domain, found, now);
	return found;
}

// Whether an address may sign up: { email, accepted, reason, message, source }. reason is invalid, blocked,
// disposable or no_mail_server, and message is the sentence for the signup form. Fails open: when the
// lookups can't answer, the address is accepted.
export async function checkEmail(input, { now = new Date() } = {}) {
	const email = normalizeEmail(input);
	if (!email) return toCheckResult(null, "invalid", { email: typeof input === "string" ? input : null });

	try {
		const rule = findRule(email, await loadRules());
		if (rule?.action === "block") return toCheckResult(email, "blocked", { source: "rule" });
		if (rule?.action === "allow") return toCheckResult(email, null, { source: "rule" });

		const domain = getEmailDomain(email);
		const found = await checkDomain(domain, now);
		if (!found) return toCheckResult(email, null, { source: "unchecked" });
		return toCheckResult(email, found.verdict === "ok" ? null : found.verdict, { source: found.source });
	} catch (error) {
		console.error("[email-check] Check failed, accepting:", error.message);
		return toCheckResult(email, null, { source: "unchecked" });
	}
}

// Signups only: an address the newsletter already has keeps working (property updates, resubscribes), so a
// new rule never cuts off someone already on the list. The refused check, or null to go ahead.
export async function checkNewSignup({ newsletter, email }) {
	const [existing] = await getDb()
		.select({ _id: contacts._id })
		.from(contacts)
		.where(and(eq(contacts.newsletterId, newsletter._id), eq(contacts.email, email)));
	if (existing) return null;
	const check = await checkEmail(email);
	return check.accepted ? null : check;
}
