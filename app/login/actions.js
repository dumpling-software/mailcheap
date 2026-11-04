"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { notifyActivity } from "@/lib/alerts";
import { isValidLogin, startSession } from "@/lib/auth";
import { isAccessEnabled } from "@/lib/access";
import { getConfigProblems } from "@/lib/config";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

const ATTEMPTS_PER_IP = { name: "login-ip", limit: 10, window: "15 m" };
// Caps guessing from many addresses at once. It's looser than the per-IP limit because whoever floods it
// also locks the admin out for the window; Cloudflare Access avoids both.
const ATTEMPTS_PER_ACCOUNT = { name: "login-account", limit: 30, window: "15 m" };

// The limiter's key, so the address isn't stored in Redis.
function accountKey(email) {
	return createHash("sha256").update(String(email ?? "").trim().toLowerCase()).digest("hex");
}

function safeNextPath(value) {
	return typeof value === "string" && /^\/(?!\/)[\w\-/]*$/.test(value) ? value : "/";
}

export async function login(_state, formData) {
	if (isAccessEnabled()) return { error: "Sign in through Cloudflare Access" };
	const problems = getConfigProblems();
	if (problems.length > 0) return { error: `Login is off until the server's settings are fixed. ${problems.join(" ")}` };

	const email = formData.get("email");
	const password = formData.get("password");

	if (
		(await isRateLimited({ ...ATTEMPTS_PER_IP, key: getClientIp(await headers()) })) ||
		(await isRateLimited({ ...ATTEMPTS_PER_ACCOUNT, key: accountKey(email) }))
	) {
		return { error: "Too many attempts. Try again in 15 minutes." };
	}

	if (!isValidLogin(email, password)) {
		// Slow down guessing; the admin account is the only account.
		await new Promise((resolve) => setTimeout(resolve, 800));
		return { error: "Wrong email or password" };
	}

	await startSession(process.env.ADMIN_EMAIL);
	await notifyActivity(["New login"], { withUserAgent: true });
	redirect(safeNextPath(formData.get("next")));
}
