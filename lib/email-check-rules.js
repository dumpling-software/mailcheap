import { normalizeEmail } from "./validation.js";

export const RULE_KINDS = ["domain", "email"];
export const RULE_ACTIONS = ["block", "allow"];
export const DOMAIN_VERDICTS = ["ok", "disposable", "no_mail_server"];

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

// The sentence a signup form shows. Every app shows the same one, so it speaks to the person signing up.
export function getCheckMessage(reason, domain = "") {
	switch (reason) {
		case "invalid":
			return "Enter a valid email address.";
		case "disposable":
			return "Disposable email addresses aren't accepted. Please sign up with a permanent address, like your work or personal email.";
		case "blocked":
			return "This email address can't be used to sign up. Please use a different one.";
		case "no_mail_server":
			return `${domain || "This domain"} can't receive email. Check the address for typos, or use a different one.`;
		default:
			return null;
	}
}

export function getEmailDomain(email) {
	return email.slice(email.lastIndexOf("@") + 1);
}

// The address without its +tag, so blocking jane@example.com blocks jane+1@example.com too.
export function stripTag(email) {
	const at = email.lastIndexOf("@");
	return email.slice(0, at).replace(/\+.*$/, "") + email.slice(at);
}

// A domain and its parents down to two labels: 29.lucktaro.com, then lucktaro.com.
export function getDomainCandidates(domain) {
	const labels = domain.split(".");
	const candidates = [];
	for (let start = 0; start <= labels.length - 2; start++) candidates.push(labels.slice(start).join("."));
	return candidates;
}

// "example.com", "@example.com" or "jane@example.com" as typed on the page: { kind, value } or an error.
export function parseRule(input) {
	const text = String(input ?? "")
		.trim()
		.toLowerCase()
		.replace(/^@/, "");
	if (text.includes("@")) {
		const email = normalizeEmail(text);
		return email ? { kind: "email", value: stripTag(email) } : { error: "Enter an email address or a domain" };
	}
	return DOMAIN_PATTERN.test(text) ? { kind: "domain", value: text } : { error: "Enter an email address or a domain" };
}

// The rule that decides the address: one for the address itself wins over one for its domain, a closer
// domain over a parent, and allow over block at the same level.
export function findRule(email, rules) {
	const address = stripTag(email);
	const levels = [
		(rule) => rule.kind === "email" && rule.value === address,
		...getDomainCandidates(getEmailDomain(email)).map((domain) => (rule) => rule.kind === "domain" && rule.value === domain),
	];
	for (const matches of levels) {
		const found = rules.filter(matches);
		if (found.length > 0) return found.find((rule) => rule.action === "allow") ?? found[0];
	}
	return null;
}

// The open-source blocklist: one domain per line, # for comments.
export function parseDomainList(text) {
	const domains = new Set();
	for (const line of String(text).split("\n")) {
		const domain = line.trim().toLowerCase();
		if (domain && !domain.startsWith("#")) domains.add(domain);
	}
	return domains;
}

export function isListed(domain, list) {
	return getDomainCandidates(domain).some((candidate) => list.has(candidate));
}

// How long a verdict holds: a disposable domain stays one, a new one shows up on the lists within days of use,
// and a domain without a mail server may only be setting one up.
export const VERDICT_DAYS = { disposable: 90, ok: 3, no_mail_server: 1 };

export function getVerdictExpiry(verdict, now = new Date()) {
	return new Date(now.getTime() + VERDICT_DAYS[verdict] * 24 * 60 * 60 * 1000);
}

export function toCheckResult(email, reason, extra = {}) {
	const domain = email ? getEmailDomain(email) : "";
	return { email, accepted: !reason, reason: reason ?? null, message: getCheckMessage(reason, domain), ...extra };
}
