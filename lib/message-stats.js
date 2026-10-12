import { sql } from "drizzle-orm";
import { messages } from "../db/schema.js";

// Each delivery and engagement counter, from the message field that records it.
export const MESSAGE_STAT_FIELDS = {
	sent: "sentAt",
	delivered: "deliveredAt",
	opened: "openedAt",
	clicked: "clickedAt",
	bounced: "bouncedAt",
	complained: "complainedAt",
};

export const MESSAGE_STAT_KEYS = Object.keys(MESSAGE_STAT_FIELDS);

// count() of a column counts the rows where it is set: { sent: count(sent_at), ... } for a select().
export function messageStatsSelect() {
	return Object.fromEntries(
		Object.entries(MESSAGE_STAT_FIELDS).map(([key, field]) => [key, sql`count(${messages[field]})::int`.mapWith(Number)])
	);
}
