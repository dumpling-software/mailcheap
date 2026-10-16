import "server-only";
import { sql } from "drizzle-orm";
import { getDb, transactionalMessages } from "@/lib/db";
import { mailboxProvider } from "@/lib/providers";

// The configuration set other apps send with (the default on their SES identities). Never Mailcheap's
// own: its events belong to messages.
export function getTransactionalSet() {
	const name = process.env.SES_TRANSACTIONAL_CONFIGURATION_SET || "transactional";
	return name === process.env.SES_CONFIGURATION_SET ? null : name;
}

// Worse states win, whatever order SNS delivers the events in: a bounce after a delay, a complaint
// after a delivery.
const STATUS_RANK = ["sent", "delayed", "delivered", "failed", "bounced", "complained"];

function rankOf(column) {
	return sql`array_position(array[${sql.join(STATUS_RANK.map((status) => sql`${status}`), sql`, `)}]::text[], ${column})`;
}

// One row per SES message, created by whichever event arrives first. Replays change nothing:
// timestamps keep their first value and the status only gets worse.
export async function recordTransactional(plan) {
	const { transactional } = plan;
	if (!plan.sesMessageId) return;
	const firstAt = (column) => sql`coalesce(${transactionalMessages[column]}, excluded.${sql.identifier(toSnake(column))})`;
	const timestamps = ["deliveredAt", "delayedAt", "bouncedAt", "complainedAt"];

	await getDb()
		.insert(transactionalMessages)
		.values({
			sesMessageId: plan.sesMessageId,
			domain: transactional.domain,
			fromAddress: transactional.fromAddress,
			email: plan.email,
			subject: transactional.subject,
			provider: plan.email ? mailboxProvider(plan.email) : null,
			status: transactional.status,
			error: plan.error?.slice(0, 500) ?? null,
			sentAt: transactional.sentAt,
			...(transactional.field && { [transactional.field]: plan.occurredAt }),
		})
		.onConflictDoUpdate({
			target: transactionalMessages.sesMessageId,
			set: {
				...Object.fromEntries(
					["domain", "fromAddress", "email", "subject", "provider", ...timestamps].map((column) => [column, firstAt(column)])
				),
				sentAt: sql`least(${transactionalMessages.sentAt}, excluded.sent_at)`,
				error: sql`coalesce(excluded.error, ${transactionalMessages.error})`,
				status: sql`case when ${rankOf(sql`excluded.status`)} > ${rankOf(transactionalMessages.status)}
					then excluded.status else ${transactionalMessages.status} end`,
			},
		});
}

function toSnake(name) {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
