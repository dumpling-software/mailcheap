import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { campaigns, contacts, getDb, jsonIncrement, messages } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { PRODUCT_UPDATES } from "@/lib/topics";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

const NO_STORE = { "Cache-Control": "no-store" };
// Bounced and complained contacts stay as they are: those statuses also block sending.
const SUBSCRIBED_STATUSES = ["active", "dormant"];
const RECENT_CAMPAIGNS = 5;
// Gmail and Yahoo send one-click requests from shared mail servers, so keep this generous.
const RATE_LIMIT = { name: "unsubscribe", limit: 60, window: "1 m" };

// Links don't carry the campaign, so the unsubscribe counts for the latest campaign sent to them (of
// the topic they left, when it was one topic).
async function creditLatestCampaign({ contactId, newsletterId, topic }) {
	const db = getDb();
	const recent = await db
		.select({ _id: campaigns._id })
		.from(campaigns)
		.where(
			and(
				eq(campaigns.newsletterId, newsletterId),
				isNotNull(campaigns.startedAt),
				topic ? eq(campaigns.topic, topic) : undefined
			)
		)
		.orderBy(desc(campaigns.startedAt))
		.limit(RECENT_CAMPAIGNS);
	for (const { _id } of recent) {
		const [wasSent] = await db
			.select({ _id: messages._id })
			.from(messages)
			.where(
				and(
					eq(messages.kind, "campaign"),
					eq(messages.campaignId, _id),
					eq(messages.contactId, contactId),
					isNotNull(messages.sentAt)
				)
			)
			.limit(1);
		if (!wasSent) continue;
		await db
			.update(campaigns)
			.set({ stats: jsonIncrement(campaigns.stats, { unsubscribed: 1 }) })
			.where(eq(campaigns._id, _id));
		return;
	}
}

async function unsubscribe({ contactId, newsletterId }) {
	// Only this newsletter's contact: the same address in other newsletters stays subscribed.
	const [previous] = await getDb()
		.update(contacts)
		.set({ status: "unsubscribed", unsubscribedAt: new Date() })
		.where(
			and(
				eq(contacts._id, contactId),
				eq(contacts.newsletterId, newsletterId),
				inArray(contacts.status, SUBSCRIBED_STATUSES)
			)
		)
		.returning({ _id: contacts._id, unsubscribedTopics: contacts.unsubscribedTopics });
	if (!previous) return;

	console.log(`[unsubscribe] Contact ${contactId} unsubscribed from newsletter ${newsletterId}`);
	// Already counted when they left product updates.
	if (previous.unsubscribedTopics?.includes(PRODUCT_UPDATES)) return;
	await creditLatestCampaign({ contactId, newsletterId }).catch((error) =>
		console.error("[unsubscribe] Could not credit the campaign:", error.message)
	);
}

// One topic only: the contact stays on the newsletter for the others, whatever its status (a reader
// who comes back later still doesn't get this topic).
async function unsubscribeFromTopic({ contactId, newsletterId, topic }) {
	const [previous] = await getDb()
		.update(contacts)
		.set({ unsubscribedTopics: sql`array_append(${contacts.unsubscribedTopics}, ${topic}::text)` })
		.where(
			and(
				eq(contacts._id, contactId),
				eq(contacts.newsletterId, newsletterId),
				sql`not (${topic}::text = any(${contacts.unsubscribedTopics}))`
			)
		)
		.returning({ _id: contacts._id, status: contacts.status });
	if (!previous) return;

	console.log(`[unsubscribe] Contact ${contactId} unsubscribed from ${topic} in newsletter ${newsletterId}`);
	// Campaign stats count unsubscribes from campaigns; automations have no campaign to credit.
	if (topic !== PRODUCT_UPDATES || !SUBSCRIBED_STATUSES.includes(previous.status)) return;
	await creditLatestCampaign({ contactId, newsletterId, topic }).catch((error) =>
		console.error("[unsubscribe] Could not credit the campaign:", error.message)
	);
}

function redirectToPage(request, params) {
	const url = new URL("/unsubscribe", request.url);
	for (const [key, value] of Object.entries(params)) {
		if (value) url.searchParams.set(key, value);
	}
	const response = NextResponse.redirect(url, 303);
	response.headers.set("Cache-Control", "no-store");
	return response;
}

// Some mail apps open the List-Unsubscribe URL in a browser: never change anything on GET.
export function GET(request) {
	return redirectToPage(request, { token: new URL(request.url).searchParams.get("token") });
}

// RFC 8058 one-click endpoint. The confirmation page form posts here too, with source=page. A token
// with a topic leaves that topic only; scope=all (the page's "unsubscribe from all" button) and tokens
// without a topic leave the whole newsletter.
export async function POST(request) {
	const token = new URL(request.url).searchParams.get("token");
	const form = await request.formData().catch(() => null);
	const isPageForm = form?.get("source") === "page";
	const isAll = form?.get("scope") === "all";

	function respond(status, pageStatus, scope) {
		if (!isPageForm) return new NextResponse(null, { status, headers: NO_STORE });
		return redirectToPage(request, {
			token: pageStatus === "invalid" ? null : token,
			status: pageStatus,
			scope,
		});
	}

	if (await isRateLimited({ ...RATE_LIMIT, key: getClientIp(request.headers) })) return respond(429, "error");

	const reference = verifyUnsubscribeToken(token);
	if (!reference) return respond(400, "invalid");

	try {
		if (reference.topic && !isAll) {
			await unsubscribeFromTopic(reference);
			return respond(200, "done", "topic");
		}
		await unsubscribe(reference);
		return respond(200, "done", "all");
	} catch (error) {
		console.error("[unsubscribe] Failed:", error);
		return respond(500, "error");
	}
}
