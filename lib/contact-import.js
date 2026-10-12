import { sql } from "drizzle-orm";
import { contacts, query, suppressions, timestamp } from "./db.js";
import { STATUS_RANK, sanitizeImportRow } from "./csv-import.js";

const SUPPRESSION_REASONS = { bounced: "bounce", complained: "complaint" };
const INSERT_CHUNK_SIZE = 1000;

function weakerStatuses(status) {
	return Object.keys(STATUS_RANK).filter((key) => STATUS_RANK[key] < STATUS_RANK[status]);
}

// One row per contact: new contacts take the file's status, existing ones keep theirs and only get the
// file's engagement numbers (imported).
export function getContactRows({ newsletterId, contacts: rows, source, now = new Date() }) {
	return rows.map(({ email, status, subscribedAt, emailsReceived, openRate, clickRate }) => {
		const imported = Object.fromEntries(
			Object.entries({ emailsReceived, openRate, clickRate }).filter(([, value]) => value !== undefined)
		);
		return {
			newsletterId,
			email,
			status,
			source,
			subscribedAt: subscribedAt ?? now,
			unsubscribedAt: status === "unsubscribed" ? now : null,
			imported: Object.keys(imported).length > 0 ? imported : null,
		};
	});
}

// Each status the rows move existing contacts to, with the weaker statuses it replaces. Nothing moves a
// contact to active, and pending has no rank, so a contact waiting to confirm stays as it is.
export function getStatusChanges(rows) {
	return Object.entries(Object.groupBy(rows, ({ status }) => status))
		.filter(([status]) => status !== "active")
		.map(([status, group]) => ({
			status,
			emails: group.map(({ email }) => email),
			replaces: weakerStatuses(status),
		}));
}

async function upsertContactRows(rows, run) {
	let created = 0;
	for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
		const chunk = rows.slice(index, index + INSERT_CHUNK_SIZE);
		const values = sql.join(
			chunk.map(
				(row) =>
					sql`(${row.newsletterId}::uuid, ${row.email}, ${row.status}, ${row.source}, ${timestamp(row.subscribedAt)}, ${timestamp(row.unsubscribedAt)}, ${row.imported ? JSON.stringify(row.imported) : null}::jsonb)`
			),
			sql`, `
		);
		const result = await run(sql`
			insert into ${contacts} (newsletter_id, email, status, source, subscribed_at, unsubscribed_at, imported)
			values ${values}
			on conflict (newsletter_id, email) do update set
				imported = coalesce(${contacts.imported}, '{}'::jsonb) || excluded.imported
				where excluded.imported is not null
			returning (xmax = 0) as inserted`);
		created += result.filter(({ inserted }) => inserted).length;
	}
	return created;
}

// Never deletes and never moves a contact back to a weaker status: an unsubscribe, bounce or
// complaint always wins.
export async function importContactRows({ newsletterId, rows, source = "import", run = query }) {
	const unique = [
		...new Map(rows.map(sanitizeImportRow).filter(Boolean).map((row) => [row.email, row])).values(),
	];
	if (unique.length === 0) return { created: 0, existing: 0, invalid: rows.length };

	const created = await upsertContactRows(getContactRows({ newsletterId, contacts: unique, source }), run);

	const changes = getStatusChanges(unique);
	for (const { status, emails, replaces } of changes) {
		if (replaces.length === 0) continue;
		await run(sql`
			update ${contacts} set status = ${status}
				${status === "unsubscribed" ? sql`, unsubscribed_at = now()` : sql``}
			where newsletter_id = ${newsletterId}
				and email in ${emails}
				and status in ${replaces}`);
	}

	for (const { status, emails } of changes.filter(({ status }) => SUPPRESSION_REASONS[status])) {
		const values = sql.join(
			emails.map((email) => sql`(${email}, ${SUPPRESSION_REASONS[status]}, ${source})`),
			sql`, `
		);
		await run(sql`insert into ${suppressions} (email, reason, detail) values ${values} on conflict (email) do nothing`);
	}

	return { created, existing: unique.length - created, invalid: rows.length - unique.length };
}
