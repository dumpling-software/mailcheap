import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { generateApiKey } from "../../lib/api-keys.js";
import { apiKeys, contacts, emailDomainChecks, emailRules } from "../../lib/db.js";
import { checkDomains, checkEmail, setEmailCheckLookups } from "../../lib/email-check.js";
import { createTestDb, seedContact, seedNewsletter } from "../helpers/db.mjs";

process.env.SESSION_SECRET = "s".repeat(40);
process.env.APP_URL = "https://mail.example.com";
delete process.env.SENDING_ENABLED;

let testDb;
let apiKey;
let calls;
before(async () => {
	testDb = await createTestDb();
	const { key, prefix, hash } = generateApiKey();
	await testDb.db.insert(apiKeys).values({ name: "site", prefix, hash });
	apiKey = key;
});
after(() => testDb.close());
beforeEach(async () => {
	await testDb.db.delete(emailRules);
	await testDb.db.delete(emailDomainChecks);
	calls = { service: [], mx: [] };
	setEmailCheckLookups({
		loadList: async () => new Set(["playfine.com"]),
		checkWithService: async (domain, { paid } = {}) => {
			calls.service.push(domain);
			calls.paid = paid;
			if (domain === "down.example") return null;
			return { verdict: ["lugiz.com", "kiwof.com"].includes(domain) ? "disposable" : "ok", source: "verifymail" };
		},
		lookUpMailServer: async (domain) => {
			calls.mx.push(domain);
			if (domain === "gmial.com") return { verdict: "no_mail_server", source: "dns" };
			if (domain === "down.example") return null;
			return { verdict: "ok", source: "dns" };
		},
	});
});

function apiRequest(path, body) {
	return new Request(`https://mail.example.com${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("the lists, then the service, then DNS decide, and each domain is looked up once", async () => {
	assert.deepEqual(
		{ ...(await checkEmail("A@29.Playfine.com")), message: undefined },
		{ email: "a@29.playfine.com", accepted: false, reason: "disposable", message: undefined, source: "list" }
	);
	assert.equal((await checkEmail("x@lugiz.com")).source, "verifymail");
	assert.equal((await checkEmail("y@lugiz.com")).reason, "disposable");
	assert.deepEqual(calls.service, ["lugiz.com"]);

	const typo = await checkEmail("dana@gmial.com");
	assert.equal(typo.reason, "no_mail_server");
	assert.equal(typo.message, "gmial.com can't receive email. Check the address for typos, or use a different one.");

	const fine = await checkEmail("dana@gmail.com");
	assert.equal(fine.accepted, true);
	assert.equal(fine.message, null);
	assert.equal((await checkEmail("not an email")).reason, "invalid");
});

test("a domain no service could judge goes through on its mail server, unsaved, and stays pending in a sweep", async () => {
	setEmailCheckLookups({
		loadList: async () => new Set(),
		checkWithService: async () => null,
		lookUpMailServer: async () => ({ verdict: "ok", source: "dns" }),
	});
	assert.equal((await checkEmail("dana@throttled.example")).accepted, true);
	assert.equal((await testDb.db.select().from(emailDomainChecks).where(eq(emailDomainChecks.domain, "throttled.example"))).length, 0);
	assert.deepEqual(await checkDomains(["throttled.example"]), { "throttled.example": null });
});

test("when nothing answers the address goes through, and nothing is saved", async () => {
	const result = await checkEmail("dana@down.example");
	assert.equal(result.accepted, true);
	assert.equal(result.source, "unchecked");
	assert.equal((await testDb.db.select().from(emailDomainChecks).where(eq(emailDomainChecks.domain, "down.example"))).length, 0);
});

test("rules block and allow ahead of every lookup", async () => {
	await testDb.db.insert(emailRules).values([
		{ kind: "domain", value: "powerscrews.com", action: "block" },
		{ kind: "email", value: "automator42@proton.me", action: "block" },
		{ kind: "domain", value: "kiwof.com", action: "allow" },
	]);
	setEmailCheckLookups(null);
	setEmailCheckLookups({
		loadList: async () => new Set(),
		checkWithService: async () => assert.fail("rules come first"),
		lookUpMailServer: async () => assert.fail("rules come first"),
	});
	assert.equal((await checkEmail("ann@powerscrews.com")).reason, "blocked");
	assert.equal((await checkEmail("automator42+9@proton.me")).reason, "blocked");
	assert.equal((await checkEmail("ann@kiwof.com")).accepted, true);
});

test("the email-check API answers with the sentence to show", async () => {
	const { POST } = await import("../../app/api/v1/email-check/route.js");
	const response = await POST(apiRequest("/api/v1/email-check", { email: "bot@lugiz.com" }));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(Object.keys(body).sort(), ["accepted", "email", "message", "reason"]);
	assert.equal(body.accepted, false);
	assert.equal(body.reason, "disposable");
	assert.match(body.message, /permanent address/);

	const bad = await POST(new Request("https://mail.example.com/api/v1/email-check", { method: "POST", body: "{}" }));
	assert.equal(bad.status, 401);
});

test("the contacts API refuses new disposable signups but keeps updating contacts it has", async () => {
	const { POST } = await import("../../app/api/v1/contacts/route.js");
	const newsletter = await seedNewsletter(testDb.db, { slug: "check-weekly" });

	const refused = await POST(apiRequest("/api/v1/contacts", { newsletter: "check-weekly", email: "bot@kiwof.com" }));
	assert.equal(refused.status, 422);
	const body = await refused.json();
	assert.equal(body.reason, "disposable");
	assert.match(body.error, /Disposable email addresses aren't accepted/);
	assert.equal((await testDb.db.select().from(contacts).where(eq(contacts.email, "bot@kiwof.com"))).length, 0);

	await seedContact(testDb.db, newsletter, { email: "old@lugiz.com" });
	const updated = await POST(
		apiRequest("/api/v1/contacts", { newsletter: "check-weekly", email: "old@lugiz.com", properties: { plan: "pro" } })
	);
	assert.equal(updated.status, 200);
});

test("a sweep answers rules, lists and saved verdicts at once, looks up the rest, and leaves what's late pending", async () => {
	await testDb.db.insert(emailRules).values([
		{ kind: "domain", value: "agentmail.to", action: "allow" },
		{ kind: "domain", value: "powerscrews.com", action: "block" },
	]);
	await checkEmail("x@kiwof.com");
	calls.service = [];

	const results = await checkDomains(["agentmail.to", "powerscrews.com", "29.playfine.com", "kiwof.com", "lugiz.com", "gmail.com"], {
		paid: false,
	});
	assert.deepEqual(results["agentmail.to"], { verdict: "allowed", source: "rule" });
	assert.deepEqual(results["powerscrews.com"], { verdict: "blocked", source: "rule" });
	assert.deepEqual(results["29.playfine.com"], { verdict: "disposable", source: "list" });
	assert.deepEqual(results["kiwof.com"], { verdict: "disposable", source: "verifymail" });
	assert.equal(results["lugiz.com"].verdict, "disposable");
	assert.equal(results["gmail.com"].verdict, "ok");
	assert.deepEqual(calls.service.sort(), ["gmail.com", "lugiz.com"]);
	assert.equal(calls.paid, false);

	const late = await checkDomains(["late.example", "later.example"], { deadline: Date.now() - 1 });
	assert.deepEqual(late, { "late.example": null, "later.example": null });
});

test("the domains API sweeps up to 1000 domains and counts what's pending", async () => {
	const { POST } = await import("../../app/api/v1/email-check/domains/route.js");
	const response = await POST(apiRequest("/api/v1/email-check/domains", { domains: ["Lugiz.com", "gmail.com", "not a domain"] }));
	assert.equal(response.status, 200);
	const { results, pending } = await response.json();
	assert.deepEqual(Object.keys(results).sort(), ["gmail.com", "lugiz.com"]);
	assert.equal(results["lugiz.com"].verdict, "disposable");
	assert.equal(pending, 0);
	const quick = await (await POST(apiRequest("/api/v1/email-check/domains", { domains: ["fresh.example"], wait: 0 }))).json();
	assert.deepEqual(quick, { results: { "fresh.example": null }, pending: 1 });
	const tooMany = await POST(apiRequest("/api/v1/email-check/domains", { domains: Array.from({ length: 1001 }, (_, i) => `d${i}.com`) }));
	assert.equal(tooMany.status, 400);
});
