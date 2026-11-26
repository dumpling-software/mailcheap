import crypto from "node:crypto";
import { getAppUrl, getLinkSecrets } from "./config.js";
import { isTopic } from "./topics.js";
import { isUuid } from "./validation.js";

// base64url JSON payload + "." + base64url HMAC-SHA256 (always 43 characters)
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{43}$/;

// Rotating SESSION_SECRET invalidates every unsubscribe link in already-sent emails, unless the old value
// stays in SESSION_SECRET_PREVIOUS (lib/config.js getLinkSecrets).
function getSigningKey(secret = process.env.SESSION_SECRET) {
	if (!secret) throw new Error("SESSION_SECRET is required to sign unsubscribe links");
	return Buffer.from(crypto.hkdfSync("sha256", secret, "", "mailcheap-unsubscribe-v1", 32));
}

function sign(payload, secret) {
	return crypto.createHmac("sha256", getSigningKey(secret)).update(payload).digest("base64url");
}

function isSigned(payload, signature) {
	const provided = Buffer.from(signature);
	return getLinkSecrets().some((secret) => {
		const expected = Buffer.from(sign(payload, secret));
		return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
	});
}

function isValidReference({ contactId, newsletterId }) {
	return isUuid(contactId) && isUuid(newsletterId);
}

// Tokens never expire: links in old emails must keep working (CAN-SPAM requires at least 30 days).
// topic (lib/topics.js, optional): the link leaves only that topic. Tokens without one, like every
// link sent before topics existed, unsubscribe from the whole newsletter.
export function createUnsubscribeToken({ contactId, newsletterId, topic = null }) {
	const reference = {
		contactId: String(contactId ?? "").toLowerCase(),
		newsletterId: String(newsletterId ?? "").toLowerCase(),
	};
	if (!isValidReference(reference)) throw new Error("Invalid unsubscribe reference");
	if (topic != null && !isTopic(topic)) throw new Error("Invalid unsubscribe topic");

	const payload = Buffer.from(
		JSON.stringify({ c: reference.contactId, n: reference.newsletterId, ...(topic && { t: topic }) })
	).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;

	const [payload, signature] = token.split(".");
	if (!isSigned(payload, signature)) return null;

	try {
		const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
		if (!Object.hasOwn(data, "c") || !Object.hasOwn(data, "n")) return null;
		const reference = { contactId: data.c, newsletterId: data.n };
		if (!isValidReference(reference)) return null;
		if (!Object.hasOwn(data, "t")) return reference;
		// Signed by us, so an unknown topic is one this version doesn't have: leaving the whole
		// newsletter would do more than the reader asked, so the link is refused instead.
		return isTopic(data.t) ? { ...reference, topic: data.t } : null;
	} catch {
		return null;
	}
}

export function getUnsubscribeLinks({ contactId, newsletterId, topic = null }) {
	const appUrl = getAppUrl();
	const query = `token=${createUnsubscribeToken({ contactId, newsletterId, topic })}`;
	return {
		pageUrl: `${appUrl}/unsubscribe?${query}`,
		headers: {
			"List-Unsubscribe": `<${appUrl}/api/unsubscribe?${query}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	};
}
