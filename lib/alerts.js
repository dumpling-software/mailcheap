import "server-only";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { after } from "next/server";
import { formatActivity } from "@/lib/activity";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { alerts, query, timestamp } from "@/lib/db";
import { getClientIp } from "@/lib/rate-limit";
import { sendSesEmail } from "@/lib/ses";

const DEFAULT_COOLDOWN_MINUTES = 60;

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// Optional: needs ALERT_FROM on a verified domain, and goes out only while sending is on.
async function sendEmail({ title, text }) {
	const { ALERT_FROM: from, ADMIN_EMAIL: to } = process.env;
	if (!from || !to || !isSendingEnabled()) return;
	await sendSesEmail({
		from,
		to,
		subject: `[Mailcheap] ${title}`,
		text,
		html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
	});
}

// Claims the alert's slot: inserts it, or takes it over once the cooldown is over. Inside the cooldown
// the update's condition fails and nothing comes back.
async function claimAlert({ key, title, cooldownMinutes }) {
	const now = new Date();
	const cutoff = new Date(now.getTime() - cooldownMinutes * 60_000);
	const rows = await query(sql`
		insert into ${alerts} (key, title, last_sent_at) values (${key}, ${title}, ${timestamp(now)})
		on conflict (key) do update set title = excluded.title, last_sent_at = excluded.last_sent_at
			where alerts.last_sent_at is null or alerts.last_sent_at < ${timestamp(cutoff)}
		returning id`);
	return rows.length > 0;
}

// Never throws: a failing alert must not break a send or a webhook. Always logged; emailed to
// ADMIN_EMAIL at most once per cooldown.
export async function sendAlert({ key, title, detail, path = "", cooldownMinutes = DEFAULT_COOLDOWN_MINUTES }) {
	console.warn(`[alert] ${title}: ${detail}`);
	try {
		if (!(await claimAlert({ key, title, cooldownMinutes }))) return;
		await sendEmail({ title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", error?.message);
	}
}

// Logins, new API keys and sends, every time: logged, and emailed only with ALERT_ACTIVITY=true, so the
// inbox gets problems, not routine. It goes out after the response, so a failing alert never holds up or
// blocks the action.
export async function notifyActivity(lines, { withUserAgent = false } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("x-vercel-ip-country"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		after(async () => {
			console.info(`[activity] ${text.replaceAll("\n", " | ")}`);
			if (process.env.ALERT_ACTIVITY !== "true") return;
			try {
				await sendEmail({ title: lines[0], text });
			} catch (error) {
				console.error("[alert] Activity notice failed:", error?.message);
			}
		});
	} catch (error) {
		console.error("[alert] Activity notice failed:", error?.message);
	}
}
