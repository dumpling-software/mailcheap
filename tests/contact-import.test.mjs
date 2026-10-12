import assert from "node:assert/strict";
import { test } from "node:test";
import { getContactRows, getStatusChanges } from "../lib/contact-import.js";

const newsletterId = "74f1a2b3-c4d5-e6f7-a8b9-c0d200000000";
const subscribedAt = new Date("2026-10-08T09:00:00.000Z");

// Rows as sanitizeImportRow hands them over, one per status a CSV file can map to.
const contacts = [
	{ email: "new@example.com", status: "active", subscribedAt, openRate: 0.5 },
	{ email: "left@example.com", status: "unsubscribed" },
	{ email: "left-too@example.com", status: "unsubscribed" },
	{ email: "bounced@example.com", status: "bounced" },
	{ email: "cold@example.com", status: "dormant", emailsReceived: 9, openRate: 0, clickRate: 0 },
];

test("rows add the contacts a newsletter doesn't have and only make statuses stricter", () => {
	const now = new Date("2026-10-12T00:00:00.000Z");
	const rows = getContactRows({ newsletterId, contacts, source: "import", now });
	assert.equal(rows.length, contacts.length);
	assert.deepEqual(rows[0], {
		newsletterId,
		email: "new@example.com",
		status: "active",
		source: "import",
		subscribedAt,
		unsubscribedAt: null,
		imported: { openRate: 0.5 },
	});
	assert.equal(rows[1].unsubscribedAt, now);
	assert.equal(rows[1].subscribedAt, now, "no signup date: the import time");
	assert.equal(rows[1].imported, null);

	assert.deepEqual(getStatusChanges(contacts), [
		{ status: "unsubscribed", emails: ["left@example.com", "left-too@example.com"], replaces: ["active", "dormant"] },
		{ status: "bounced", emails: ["bounced@example.com"], replaces: ["active", "dormant", "unsubscribed"] },
		{ status: "dormant", emails: ["cold@example.com"], replaces: ["active"] },
	]);
});

test("existing contacts never become active and contacts waiting to confirm stay as they are", () => {
	for (const { status, replaces } of getStatusChanges(contacts)) {
		assert.notEqual(status, "active");
		assert.equal(replaces.includes("pending"), false);
	}
});
