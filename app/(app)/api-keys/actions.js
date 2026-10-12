"use server";

import { isUuid } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { notifyActivity } from "@/lib/alerts";
import { generateApiKey } from "@/lib/api-keys";
import { requireSession } from "@/lib/auth";
import { getAppUrl } from "@/lib/config";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, getDb } from "@/lib/db";

export async function createApiKey(_state, formData) {
	await requireSession();
	const name = String(formData.get("name") ?? "")
		.trim()
		.slice(0, 60);
	if (!name) return { error: "Name is required" };

	const { key, prefix, hash } = generateApiKey();
	await getDb().insert(apiKeys).values({ name, prefix, hash });
	await notifyActivity([`API key created: ${name}`, `${getAppUrl()}/api-keys`]);

	revalidatePath("/api-keys");
	return { key };
}

export async function revokeApiKey(id) {
	await requireSession();
	if (!isUuid(id)) return { error: "Key not found" };

	await getDb()
		.update(apiKeys)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiKeys._id, id), isNull(apiKeys.revokedAt)));

	revalidatePath("/api-keys");
	return { ok: true };
}
