import "server-only";
import { hashApiKey, readBearerToken, shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, getDb } from "@/lib/db";

export { generateApiKey, hashApiKey } from "@/lib/api-key-tokens";

export async function authenticateRequest(request) {
	const key = readBearerToken(request.headers.get("authorization"));
	if (!key) return null;

	const db = getDb();
	const [apiKey] = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.hash, hashApiKey(key)), isNull(apiKeys.revokedAt)));
	if (!apiKey) return null;

	const now = new Date();
	if (shouldTouchLastUsed(apiKey.lastUsedAt, now.getTime())) {
		await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys._id, apiKey._id)).catch((error) =>
			console.error("[api-keys] Could not update lastUsedAt:", error.message)
		);
	}
	return apiKey;
}
