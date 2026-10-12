"use server";

import { isUuid } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { importContactRows } from "@/lib/contact-import";
import { MAX_IMPORT_ROWS_PER_REQUEST } from "@/lib/csv-import";
import { and, eq, inArray } from "drizzle-orm";
import { contacts, getDb } from "@/lib/db";
import { engagement } from "@/lib/engagement";
import { findNewsletter } from "@/lib/records";

export async function importContacts({ newsletterId, rows }) {
	await requireSession();
	if (!isUuid(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };

	if (!(await findNewsletter(newsletterId))) return { error: "Newsletter not found" };

	const result = await importContactRows({ newsletterId, rows });
	revalidatePath("/contacts");
	return result;
}

export async function setContactStatus(id, status) {
	await requireSession();
	if (!isUuid(id) || !["active", "unsubscribed"].includes(status)) {
		return { error: "Invalid request" };
	}

	// Reactivation only applies to dormant contacts; unsubscribes, bounces and complaints are final. It
	// starts the list cleanup over, or the next send would make them dormant again.
	const from = status === "active" ? ["dormant"] : ["active", "dormant", "pending"];
	const changes = status === "active" ? { status, ...engagement() } : { status, unsubscribedAt: new Date() };
	const updated = await getDb()
		.update(contacts)
		.set(changes)
		.where(and(eq(contacts._id, id), inArray(contacts.status, from)))
		.returning({ _id: contacts._id });

	revalidatePath("/contacts");
	return updated.length > 0 ? { ok: true } : { error: "Status cannot change" };
}
