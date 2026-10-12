import { NextResponse } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { withQStashSignature } from "@/lib/qstash-route";
import { sendMessageBatch } from "@/lib/sending";
import { MAX_BATCH_MESSAGES } from "@/lib/sending-rules";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handleBatch(request) {
	if (!isSendingEnabled()) return NextResponse.json({ error: "Sending is off" }, { status: 409 });

	const body = await request.json().catch(() => null);
	const messageIds = body?.messageIds;
	const isValid =
		Array.isArray(messageIds) &&
		messageIds.length > 0 &&
		messageIds.length <= MAX_BATCH_MESSAGES &&
		messageIds.every(isUuid);
	if (!isValid) {
		return NextResponse.json(
			{ error: `messageIds must be 1 to ${MAX_BATCH_MESSAGES} message ids` },
			{ status: 400 }
		);
	}

	const result = await sendMessageBatch(messageIds);
	// QStash retries non-2xx responses, which is what a throttled batch needs.
	return NextResponse.json(result, { status: result.retry ? 503 : 200 });
}

export const POST = withQStashSignature(handleBatch);
