import "server-only";
import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAccessEnabled, readAccessToken, verifyAccessToken } from "@/lib/access";
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE,
	signSessionToken,
	verifySessionToken,
} from "@/lib/session-token";

function digest(value) {
	return crypto.createHash("sha256").update(String(value ?? "")).digest();
}

export function isValidLogin(email, password) {
	const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
	if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false;
	const emailOk = crypto.timingSafeEqual(digest(email?.trim().toLowerCase()), digest(ADMIN_EMAIL.trim().toLowerCase()));
	const passwordOk = crypto.timingSafeEqual(digest(password), digest(ADMIN_PASSWORD));
	return emailOk && passwordOk;
}

// Browsers ignore a __Host- cookie, even an expired one, unless it's Secure with Path=/.
const COOKIE_OPTIONS = {
	httpOnly: true,
	secure: process.env.NODE_ENV === "production",
	sameSite: "lax",
	path: "/",
};

export async function startSession(email) {
	const store = await cookies();
	store.set(SESSION_COOKIE, await signSessionToken(email), { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE });
}

export async function endSession() {
	const store = await cookies();
	store.delete({ name: SESSION_COOKIE, ...COOKIE_OPTIONS });
}

export async function getSession() {
	const store = await cookies();
	if (isAccessEnabled()) return verifyAccessToken(readAccessToken(await headers(), store));
	return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

// Server actions run outside proxy.js matching rules, so they re-check the session themselves.
export async function requireSession() {
	const session = await getSession();
	if (session) return session;
	// Behind Access, the login page can't help (it sends a signed-in visitor home): only Access can.
	if (isAccessEnabled()) throw new Error("Unauthorized: sign in through Cloudflare Access");
	redirect("/login");
}
