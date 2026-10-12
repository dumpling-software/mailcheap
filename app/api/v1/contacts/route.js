import { NextResponse, after } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { authenticateRequest } from "@/lib/api-keys";
import { onContactCreated, onPropertiesChanged } from "@/lib/automations/hooks";
import { isSendingEnabled } from "@/lib/config";
import { eraseContact, mergeProperties, resolveNewsletter } from "@/lib/contact-events";
import { upsertContact } from "@/lib/contacts";
import { getInbox } from "@/lib/inbox-links";
import { readProperties } from "@/lib/properties";
import { isRateLimited } from "@/lib/rate-limit";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { isPlainObject, normalizeEmail } from "@/lib/validation";

const MAX_SOURCE_LENGTH = 100;
// Each signup can send a welcome email, so a leaked key or a form without its own limit must not be
// able to flood the list. Sites that pass their visitor's IP get the archive form's per-visitor limit.
const PER_KEY = { name: "api-contacts-key", limit: 600, window: "1 h" };
const PER_VISITOR = { name: "api-contacts-ip", limit: 5, window: "10 m" };
const ERASURES_PER_KEY = { name: "api-contacts-erase", limit: 600, window: "1 h" };
const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;

function fail(status, error) {
	return NextResponse.json({ error }, { status });
}

function readInput(body) {
	if (!isPlainObject(body)) return { error: "Send a JSON object" };
	const { newsletter, email, source, resubscribe, ip } = body;
	if (typeof newsletter !== "string" || !newsletter.trim()) return { error: "newsletter is required" };

	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) return { error: "email is invalid" };
	if (source !== undefined && (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH)) {
		return { error: `source must be a string of at most ${MAX_SOURCE_LENGTH} characters` };
	}
	if (resubscribe !== undefined && typeof resubscribe !== "boolean") {
		return { error: "resubscribe must be a boolean" };
	}
	const { properties, error } = readProperties(body.properties, { allowNull: true });
	if (error) return { error };
	return {
		newsletter,
		email: normalizedEmail,
		source: source?.trim() || "api",
		resubscribe: resubscribe === true,
		ip: typeof ip === "string" && IP_PATTERN.test(ip) ? ip : null,
		properties,
	};
}

// Adds a contact, or updates one: signing up again never sends the welcome email twice, and properties
// merge into the ones the contact has (null removes one).
export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");

	const input = readInput(await request.json().catch(() => null));
	if (input.error) return fail(400, input.error);

	const keyId = String(apiKey._id);
	if (await isRateLimited({ ...PER_KEY, key: keyId })) {
		await sendAlert({
			key: `api-signup-flood:${keyId}`,
			title: "API signups paused",
			detail: `The "${apiKey.name}" key sent over ${PER_KEY.limit} signups in an hour. New ones are refused until it slows down. If that isn't your site, revoke the key.`,
			path: "/api-keys",
		});
		return fail(429, "Too many signups, try again later");
	}
	if (input.ip && (await isRateLimited({ ...PER_VISITOR, key: `${keyId}:${input.ip}` }))) {
		return fail(429, "Too many signups from this visitor, try again later");
	}

	const resolved = await resolveNewsletter(input.newsletter, apiKey);
	if (resolved.error) return fail(resolved.status, resolved.error);
	const { newsletter } = resolved;

	const { contact: upserted, created } = await upsertContact({
		newsletter,
		email: input.email,
		source: input.source,
		resubscribe: input.resubscribe,
	});
	const { after: properties, changes } = await mergeProperties(upserted._id, input.properties);
	const contact = properties ? { ...upserted, properties } : upserted;

	// A pending contact who signs up again gets the confirmation again (throttled per address).
	const isPending = contact.status === "pending";
	if (isSendingEnabled() && (isPending || (created && contact.status === "active"))) {
		const queue = isPending ? queueConfirmationEmail : queueWelcomeEmail;
		after(() =>
			queue({ newsletter, contact }).catch((error) =>
				console.error(`[api/contacts] Signup email for ${contact._id} failed:`, error.message)
			)
		);
	}
	after(async () => {
		try {
			if (created) await onContactCreated({ newsletter, contact });
			else if (changes.length > 0) await onPropertiesChanged({ newsletter, contact, changes });
		} catch (error) {
			console.error(`[api/contacts] Automations for ${contact._id} failed:`, error.message);
		}
	});

	return NextResponse.json(
		{
			id: String(contact._id),
			status: contact.status,
			created,
			properties: contact.properties ?? {},
			// For the site's "check your inbox" message.
			...(isPending && { inbox: getInbox({ email: contact.email, fromEmail: newsletter.fromEmail }) }),
		},
		{ status: created ? 201 : 200 }
	);
}

// GDPR erasure: { email } removes the address from every newsletter, { email, newsletter } from one.
// A key made for one newsletter only erases there.
export async function DELETE(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...ERASURES_PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many requests");

	const body = await request.json().catch(() => null);
	if (!isPlainObject(body)) return fail(400, "Send a JSON object");
	const email = normalizeEmail(body.email);
	if (!email) return fail(400, "email is invalid");

	let newsletterId = null;
	if (body.newsletter !== undefined || apiKey.newsletterId) {
		const resolved = await resolveNewsletter(body.newsletter ?? apiKey.newsletterId, apiKey);
		if (resolved.error) return fail(resolved.status, resolved.error);
		newsletterId = resolved.newsletter._id;
	}

	const { deleted } = await eraseContact({ email, newsletterId });
	console.info(`[api/contacts] Erased ${deleted} contact(s)${newsletterId ? ` in ${newsletterId}` : ""}`);
	return NextResponse.json({ deleted });
}
