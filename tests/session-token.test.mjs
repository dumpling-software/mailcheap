import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, decodeJwt } from "jose";

process.env.SESSION_SECRET = "s".repeat(40);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "correct horse battery staple";

const { SESSION_COOKIE, SESSION_MAX_AGE, signSessionToken, verifySessionToken } = await import("../lib/session-token.js");
const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
const { getClickUrl, getOpenUrl } = await import("../lib/tracking.js");
const { createConfirmToken } = await import("../lib/confirmation.js");
const { createKeepToken } = await import("../lib/last-chance.js");

async function withEnv(values, run) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("a session lasts 7 days and verifies while the admin login is unchanged", async () => {
	const token = await signSessionToken("admin@example.com");
	const { iat, exp } = decodeJwt(token);
	assert.equal(SESSION_MAX_AGE, 7 * 24 * 60 * 60);
	assert.equal(exp - iat, SESSION_MAX_AGE);
	assert.deepEqual(await verifySessionToken(token), { email: "admin@example.com" });
});

test("changing the admin password or email signs out every session", async () => {
	const token = await signSessionToken("admin@example.com");
	await withEnv({ ADMIN_PASSWORD: "a new password here" }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	await withEnv({ ADMIN_EMAIL: "other@example.com" }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	assert.deepEqual(await verifySessionToken(token), { email: "admin@example.com" });
});

test("sessions are signed with their own key, not SESSION_SECRET itself", async () => {
	const rawKey = new TextEncoder().encode(process.env.SESSION_SECRET);
	const { v } = decodeJwt(await signSessionToken("admin@example.com"));
	for (const claims of [{ email: "admin@example.com" }, { email: "admin@example.com", v }]) {
		const forged = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(rawKey);
		assert.equal(await verifySessionToken(forged), null);
	}

	const token = await signSessionToken("admin@example.com");
	await withEnv({ SESSION_SECRET: "t".repeat(40) }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	await withEnv({ SESSION_SECRET: "s".repeat(31) }, async () => {
		assert.equal(await verifySessionToken(token), null);
		await assert.rejects(signSessionToken("admin@example.com"), /at least 32 characters/);
	});
	assert.equal(await verifySessionToken(`${token}x`), null);
	assert.equal(await verifySessionToken(""), null);
});

// Signed with SESSION_SECRET = "s" x 40. Email links don't use the session key: changing how they're signed
// breaks the links in emails already sent.
test("email links keep their signatures", () => {
	const ids = { contactId: "65f00000-0000-0000-0000-000100000000", newsletterId: "65f00000-0000-0000-0000-000200000000" };
	const at = Date.UTC(2026, 9, 1);
	assert.equal(
		createUnsubscribeToken(ids),
		"eyJjIjoiNjVmMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMTAwMDAwMDAwIiwibiI6IjY1ZjAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDIwMDAwMDAwMCJ9.sXniv6YKgEYxU7I9BfLYz6UTDNaHqsxuk7E5iuSWAsA"
	);
	assert.equal(
		getOpenUrl("https://app.example.com", "65f00000-0000-0000-0000-000300000000"),
		"https://app.example.com/o/65f00000000000000000000300000000.So24LtrZvNfwIBHka6Tbh4"
	);
	assert.equal(
		getClickUrl("https://app.example.com", "65f00000-0000-0000-0000-000300000000", "https://example.com/a"),
		"https://app.example.com/c/65f00000000000000000000300000000.cwLcfMk3315Nh1wxy-HOWv.aHR0cHM6Ly9leGFtcGxlLmNvbS9h"
	);
	assert.equal(
		createConfirmToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMTAwMDAwMDAwIiwibiI6IjY1ZjAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDIwMDAwMDAwMCIsInQiOjE3OTA4MTI4MDB9.ddkMTT4s__RVP-saptuQZi0dSEhw7Luod2KLhyrFh5U"
	);
	assert.equal(
		createKeepToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMTAwMDAwMDAwIiwibiI6IjY1ZjAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDIwMDAwMDAwMCIsInQiOjE3OTA4MTI4MDB9.YbmpRxagrJ1RaybWAMS5jM-Fmz0XRyibvMg3HYJe8G4"
	);
});

test("production keeps the session in a __Host- cookie", async () => {
	assert.equal(SESSION_COOKIE, "mailcheap_session");
	await withEnv({ NODE_ENV: "production" }, async () => {
		const production = await import("../lib/session-token.js?production");
		assert.equal(production.SESSION_COOKIE, "__Host-mailcheap_session");
	});
});
