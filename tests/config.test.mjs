import assert from "node:assert/strict";
import { test } from "node:test";
import { getConfigProblems, isArchiveEnabled } from "../lib/config.js";
import { register } from "../instrumentation.js";

const STRONG = { SESSION_SECRET: "s".repeat(32), ADMIN_PASSWORD: "p".repeat(12) };

test("SESSION_SECRET needs 32 characters and ADMIN_PASSWORD 12", () => {
	assert.deepEqual(getConfigProblems(STRONG), []);
	assert.match(getConfigProblems({ ...STRONG, SESSION_SECRET: "s".repeat(31) }).join(), /SESSION_SECRET must be at least 32/);
	assert.match(getConfigProblems({ ...STRONG, ADMIN_PASSWORD: "p".repeat(11) }).join(), /ADMIN_PASSWORD must be at least 12/);
	assert.equal(getConfigProblems({}).length, 2, "missing counts as too short");
});

test("the server doesn't start with a short secret or password", () => {
	const previous = { ...process.env };
	try {
		Object.assign(process.env, STRONG);
		assert.doesNotThrow(register);
		process.env.ADMIN_PASSWORD = "short";
		assert.throws(register, /Mailcheap can't start\. ADMIN_PASSWORD must be at least 12 characters/);
		Object.assign(process.env, STRONG, { SESSION_SECRET: "short" });
		assert.throws(register, /SESSION_SECRET must be at least 32 characters/);
	} finally {
		process.env = previous;
	}
});

test("the public archive is off unless ARCHIVE_ENABLED is exactly true", () => {
	assert.equal(isArchiveEnabled({}), false);
	assert.equal(isArchiveEnabled({ ARCHIVE_ENABLED: "1" }), false);
	assert.equal(isArchiveEnabled({ ARCHIVE_ENABLED: "TRUE" }), false);
	assert.equal(isArchiveEnabled({ ARCHIVE_ENABLED: "true" }), true);
});
