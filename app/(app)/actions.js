"use server";

import { redirect } from "next/navigation";
import { ACCESS_LOGOUT_PATH, isAccessEnabled } from "@/lib/access";
import { endSession } from "@/lib/auth";

export async function logout() {
	if (isAccessEnabled()) redirect(ACCESS_LOGOUT_PATH);
	await endSession();
	redirect("/login");
}
