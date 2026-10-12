"use server";

import { isUuid } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { notifyActivity } from "@/lib/alerts";
import { generateApiKey } from "@/lib/api-keys";
import { requireSession } from "@/lib/auth";
import { getAppUrl } from "@/lib/config";
import { findNewsletter } from "@/lib/records";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, getDb } from "@/lib/db";

export async function createApiKey(_state, formData) {
	await requireSession();
	const name = String(formData.get("name") ?? "")
		.trim()
		.slice(0, 60);
	if (!name) return { error: "Name is required" };

	// Optional: a key for one newsletter, for that product's app.
	const newsletterId = String(formData.get("newsletterId") ?? "").replace(/^all$/, "");
	const newsletter = newsletterId ? await findNewsletter(newsletterId) : null;
	if (newsletterId && !newsletter) return { error: "Newsletter not found" };

	const { key, prefix, hash } = generateApiKey();
	await getDb().insert(apiKeys).values({ name, prefix, hash, newsletterId: newsletter?._id ?? null });
	await notifyActivity([`API key created: ${name}${newsletter ? ` (${newsletter.name} only)` : ""}`, `${getAppUrl()}/api-keys`]);

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
