import { NextResponse, after } from "next/server";
import { authenticateRequest } from "@/lib/api-keys";
import { onContactCreated, onEvent } from "@/lib/automations/hooks";
import { isSendingEnabled } from "@/lib/config";
import { recordEvent, resolveNewsletter } from "@/lib/contact-events";
import { upsertContact } from "@/lib/contacts";
import { isEventName, readProperties } from "@/lib/properties";
import { isRateLimited } from "@/lib/rate-limit";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { isPlainObject, normalizeEmail } from "@/lib/validation";

// Apps report what their users do (api_key_created, first_api_call, plan_upgraded...). Generous:
// events follow product usage, not signups.
const PER_KEY = { name: "api-events-key", limit: 6000, window: "1 h" };
// An event can say when it happened, within the last 30 days and not in the future.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(status, error) {
	return NextResponse.json({ error }, { status });
}

function readInput(body, now = Date.now()) {
	if (!isPlainObject(body)) return { error: "Send a JSON object" };
	const email = normalizeEmail(body.email);
	if (!email) return { error: "email is invalid" };
	if (!isEventName(body.name)) {
		return { error: "name must start with a letter or digit and use letters, digits, _ . : - (64 at most)" };
	}
	const { properties, error } = readProperties(body.properties);
	if (error) return { error };

	let occurredAt = new Date(now);
	if (body.occurredAt !== undefined) {
		occurredAt = new Date(typeof body.occurredAt === "string" ? body.occurredAt : Number.NaN);
		const time = occurredAt.getTime();
		if (!Number.isFinite(time) || time > now + MAX_CLOCK_SKEW_MS || time < now - MAX_AGE_MS) {
			return { error: "occurredAt must be an ISO date within the last 30 days" };
		}
	}
	return { newsletter: body.newsletter, email, name: body.name, properties, occurredAt };
}

// { newsletter, email, name, properties?, occurredAt? }: records the event for the contact, creating
// the contact when the newsletter doesn't have it yet, and runs the automations it starts or wakes.
export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many events, try again later");

	const input = readInput(await request.json().catch(() => null));
	if (input.error) return fail(400, input.error);
	const resolved = await resolveNewsletter(input.newsletter, apiKey);
	if (resolved.error) return fail(resolved.status, resolved.error);
	const { newsletter } = resolved;

	const { contact, created } = await upsertContact({ newsletter, email: input.email, source: "api" });
	const event = await recordEvent({
		newsletter,
		contact,
		name: input.name,
		properties: input.properties,
		occurredAt: input.occurredAt,
	});

	if (created && isSendingEnabled() && ["active", "pending"].includes(contact.status)) {
		const queue = contact.status === "pending" ? queueConfirmationEmail : queueWelcomeEmail;
		after(() =>
			queue({ newsletter, contact }).catch((error) =>
				console.error(`[api/events] Signup email for ${contact._id} failed:`, error.message)
			)
		);
	}
	after(async () => {
		try {
			if (created) await onContactCreated({ newsletter, contact });
			await onEvent({ newsletter, contact, event });
		} catch (error) {
			console.error(`[api/events] Automations for ${contact._id} failed:`, error.message);
		}
	});

	return NextResponse.json(
		{ id: String(event._id), contactId: String(contact._id), contactStatus: contact.status, created },
		{ status: 201 }
	);
}
