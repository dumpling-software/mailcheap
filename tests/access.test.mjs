import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { getAccessConfig, readAccessToken, verifyAccessToken } from "../lib/access.js";
import { getConfigProblems } from "../lib/config.js";

const ACCESS = { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud-tag" };
const config = getAccessConfig(ACCESS);
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

function sign({ issuer = "https://team.cloudflareaccess.com", audience = "aud-tag", email = "me@example.com", expires = "1h", key = privateKey } = {}) {
	return new SignJWT(email ? { email } : {})
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime(expires)
		.sign(key);
}

test("Access is on only with both the team domain and the audience", () => {
	assert.equal(getAccessConfig({}), null);
	assert.equal(getAccessConfig({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }), null);
	assert.deepEqual(getAccessConfig({ CF_ACCESS_TEAM_DOMAIN: " https://team.cloudflareaccess.com/ ", CF_ACCESS_AUD: "aud-tag" }), {
		team: "team.cloudflareaccess.com",
		aud: "aud-tag",
	});
});

test("a token Access signed for this app is the session", async () => {
	assert.deepEqual(await verifyAccessToken(await sign(), { config, keys }), { email: "me@example.com" });
});

test("tokens for another app, another team, expired, unsigned or without an email are refused", async () => {
	const other = await generateKeyPair("RS256");
	for (const token of [
		await sign({ audience: "other-app" }),
		await sign({ issuer: "https://other.cloudflareaccess.com" }),
		await sign({ expires: "-1m" }),
		await sign({ key: other.privateKey }),
		await sign({ email: null }),
		"not-a-jwt",
		null,
	]) {
		assert.equal(await verifyAccessToken(token, { config, keys }), null);
	}
	assert.equal(await verifyAccessToken(await sign(), { config: null, keys }), null, "Access off");
});

test("the token comes from Cloudflare's header, or the browser's cookie", () => {
	const cookies = new Map([["CF_Authorization", { value: "from-cookie" }]]);
	assert.equal(readAccessToken(new Headers({ "cf-access-jwt-assertion": "from-header" }), cookies), "from-header");
	assert.equal(readAccessToken(new Headers(), cookies), "from-cookie");
	assert.equal(readAccessToken(new Headers(), new Map()), null);
});

test("behind Access, the server starts without an admin password", () => {
	const secret = { SESSION_SECRET: "s".repeat(32) };
	assert.deepEqual(getConfigProblems({ ...secret, ...ACCESS }), []);
	assert.match(getConfigProblems(secret).join(), /ADMIN_PASSWORD/);
});
