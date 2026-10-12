import "server-only";
import { cookies } from "next/headers";
import { listNewsletterSummaries } from "@/lib/records";

// The dashboard works on one newsletter (product) at a time, picked in the sidebar and kept in a cookie.
// Without a valid pick, it's the first one created.
export const CURRENT_NEWSLETTER_COOKIE = "mailcheap_newsletter";

export async function getCurrentNewsletter() {
	const [newsletters, store] = await Promise.all([listNewsletterSummaries(), cookies()]);
	const id = store.get(CURRENT_NEWSLETTER_COOKIE)?.value;
	return { newsletters, current: newsletters.find(({ _id }) => _id === id) ?? newsletters[0] ?? null };
}

// Only from server actions and route handlers, the places that can set cookies.
export async function setCurrentNewsletter(id) {
	const store = await cookies();
	store.set(CURRENT_NEWSLETTER_COOKIE, id, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 365,
	});
}
