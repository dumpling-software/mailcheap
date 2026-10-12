import "server-only";
import { sql } from "drizzle-orm";
import { contacts, later } from "@/lib/db";

// Any sign of life (an open, a click, confirming, signing up again, "keep sending it") starts the list
// cleanup's count over (lib/cleanup.js). Spread into a contacts update's set().
export function engagement(at = new Date()) {
	return { ignoredIssues: 0, lastEngagedAt: later(contacts.lastEngagedAt, at) };
}

// lib/cleanup.js getLastSignOfLife, for counting in the database.
export const LAST_SIGN_OF_LIFE = sql`greatest(${contacts.lastEngagedAt}, ${contacts.lastOpenAt}, ${contacts.lastClickAt}, ${contacts.confirmedAt}, coalesce(${contacts.subscribedAt}, ${contacts.createdAt}))`;

// Settings totals, over contacts who ever got the last-chance email.
export function cleanupTotalsQuery(newsletterId) {
	const isActive = sql`${contacts.status} = 'active'`;
	const hasAnswered = sql`${contacts.lastChanceAt} < ${LAST_SIGN_OF_LIFE}`;
	return sql`select
		count(*) filter (where ${isActive} and not ${hasAnswered})::int as waiting,
		count(*) filter (where ${isActive} and ${hasAnswered})::int as kept,
		count(*) filter (where ${contacts.status} = 'dormant')::int as dormant
		from ${contacts}
		where ${contacts.newsletterId} = ${newsletterId} and ${contacts.lastChanceAt} is not null`;
}
