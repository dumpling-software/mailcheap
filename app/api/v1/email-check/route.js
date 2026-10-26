import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-keys";
import { checkEmail } from "@/lib/email-check";
import { isRateLimited } from "@/lib/rate-limit";
import { isPlainObject } from "@/lib/validation";

// Apps check every signup before creating the account, as many as they get.
const PER_KEY = { name: "api-email-check-key", limit: 3000, window: "1 h" };

function fail(status, error) {
	return NextResponse.json({ error }, { status });
}

// { email } → { email, accepted, reason, message }: whether the address may sign up. reason is invalid,
// blocked, disposable or no_mail_server; message is the sentence to show on the signup form. Any key works,
// since the check is the same for every newsletter.
export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return fail(401, "Invalid API key");
	if (await isRateLimited({ ...PER_KEY, key: String(apiKey._id) })) return fail(429, "Too many checks, try again later");

	const body = await request.json().catch(() => null);
	if (!isPlainObject(body)) return fail(400, "Send a JSON object");
	const { email, accepted, reason, message } = await checkEmail(body.email);
	return NextResponse.json({ email, accepted, reason, message });
}
