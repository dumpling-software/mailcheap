import assert from "node:assert/strict";
import { test } from "node:test";
import { fromCompactId, isPlainObject, isUuid, normalizeEmail, toCompactId } from "../lib/validation.js";

test("emails are trimmed and lowercased", () => {
	const accepted = [
		[" Reader@Example.COM ", "reader@example.com"],
		["first.last+news@sub.example.co.uk", "first.last+news@sub.example.co.uk"],
		["o'brien@example.com", "o'brien@example.com"],
		["user@xn--e1afmkfd.xn--80akhbyknj4f", "user@xn--e1afmkfd.xn--80akhbyknj4f"],
		[`${"a".repeat(64)}@example.com`, `${"a".repeat(64)}@example.com`],
	];
	for (const [input, expected] of accepted) assert.equal(normalizeEmail(input), expected);
});

test("addresses SES can't take as a single recipient are rejected", () => {
	const rejected = [
		"",
		"plain",
		"@example.com",
		"user@",
		"user@example",
		"user@@example.com",
		"a,b@example.com",
		"a b@example.com",
		"<a@example.com>",
		"Name <a@example.com>",
		'"quoted"@example.com',
		".start@example.com",
		"end.@example.com",
		"dou..ble@example.com",
		"user@-example.com",
		"user@example-.com",
		"user@example.c",
		"user@example.123",
		"user@exa_mple.com",
		"user\r\n@example.com",
		`${"a".repeat(65)}@example.com`,
		`a@${`${"b".repeat(60)}.`.repeat(5)}com`,
		null,
		42,
		{},
	];
	for (const input of rejected) assert.equal(normalizeEmail(input), null, String(input));
});

test("ids are UUIDs, in any case", () => {
	assert.equal(isUuid("64f1a2b3-c4d5-e6f7-a8b9-c0d100000000"), true);
	assert.equal(isUuid("64F1A2B3-C4D5-E6F7-A8B9-C0D100000000"), true);
	for (const value of ["64f1a2b3c4d5e6f7a8b9c0d1", "64f1a2b3-c4d5-e6f7-a8b9-c0d10000000z", "64f1a2b3c4d5e6f7a8b9c0d100000000", 42, null]) {
		assert.equal(isUuid(value), false, String(value));
	}
});

test("compact ids drop the dashes and come back as the same UUID", () => {
	const id = "64f1a2b3-c4d5-e6f7-a8b9-c0d100000000";
	assert.equal(toCompactId(id), "64f1a2b3c4d5e6f7a8b9c0d100000000");
	assert.equal(fromCompactId(toCompactId(id.toUpperCase())), id);
	assert.equal(fromCompactId("64f1a2b3c4d5e6f7a8b9c0d1"), null);
	assert.equal(fromCompactId(id), null);
});

test("plain objects exclude arrays and null", () => {
	assert.equal(isPlainObject({}), true);
	assert.equal(isPlainObject([]), false);
	assert.equal(isPlainObject(null), false);
	assert.equal(isPlainObject("{}"), false);
});
