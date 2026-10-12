"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ACCESS_LOGOUT_PATH, isAccessEnabled } from "@/lib/access";
import { endSession, requireSession } from "@/lib/auth";
import { setCurrentNewsletter } from "@/lib/current-newsletter";
import { findNewsletter } from "@/lib/records";

export async function logout() {
	if (isAccessEnabled()) redirect(ACCESS_LOGOUT_PATH);
	await endSession();
	redirect("/login");
}

export async function selectNewsletter(id) {
	await requireSession();
	if (!(await findNewsletter(id))) return { error: "Newsletter not found" };
	await setCurrentNewsletter(id);
	revalidatePath("/", "layout");
	return { ok: true };
}
