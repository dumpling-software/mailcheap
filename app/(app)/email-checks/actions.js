"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { emailRules, getDb, query } from "@/lib/db";
import { checkEmail, forgetEmailRules } from "@/lib/email-check";
import { RULE_ACTIONS, parseRule } from "@/lib/email-check-rules";
import { isUuid } from "@/lib/validation";

export async function saveEmailRule(_state, formData) {
	await requireSession();
	const parsed = parseRule(formData.get("value"));
	if (parsed.error) return { error: parsed.error };
	const action = String(formData.get("action") ?? "");
	if (!RULE_ACTIONS.includes(action)) return { error: "Choose block or allow" };
	const note =
		String(formData.get("note") ?? "")
			.trim()
			.slice(0, 200) || null;

	// The same domain or address again replaces its rule.
	await query(sql`
		insert into ${emailRules} (kind, value, action, note) values (${parsed.kind}, ${parsed.value}, ${action}, ${note})
		on conflict (kind, value) do update set action = excluded.action, note = excluded.note`);
	forgetEmailRules();
	revalidatePath("/email-checks");
	return { ok: true, saved: parsed.value };
}

export async function deleteEmailRule(id) {
	await requireSession();
	if (!isUuid(id)) return { error: "Rule not found" };
	await getDb().delete(emailRules).where(eq(emailRules._id, id));
	forgetEmailRules();
	revalidatePath("/email-checks");
	return { ok: true };
}

export async function testEmail(_state, formData) {
	await requireSession();
	return checkEmail(String(formData.get("email") ?? ""));
}
