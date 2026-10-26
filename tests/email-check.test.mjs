import assert from "node:assert/strict";
import { test } from "node:test";
import {
	findRule,
	getCheckMessage,
	getDomainCandidates,
	isListed,
	parseDomainList,
	parseRule,
	stripTag,
	toCheckResult,
} from "../lib/email-check-rules.js";

test("rules are typed as a domain, @domain or an address, which loses its +tag", () => {
	assert.deepEqual(parseRule(" Example.COM "), { kind: "domain", value: "example.com" });
	assert.deepEqual(parseRule("@powerscrews.com"), { kind: "domain", value: "powerscrews.com" });
	assert.deepEqual(parseRule("Automator42+17@proton.me"), { kind: "email", value: "automator42@proton.me" });
	for (const bad of ["", "nodot", "a@", "exa mple.com", "-bad.com", "@"]) assert.ok(parseRule(bad).error, bad);
});

test("the address's own rule beats its domain's, a closer domain beats a parent, and allow beats block", () => {
	const rules = [
		{ kind: "domain", value: "proton.me", action: "block" },
		{ kind: "email", value: "dana@proton.me", action: "allow" },
		{ kind: "domain", value: "lucktaro.com", action: "block" },
		{ kind: "domain", value: "ok.lucktaro.com", action: "allow" },
		{ kind: "email", value: "automator42@gmail.com", action: "block" },
	];
	assert.equal(findRule("dana+news@proton.me", rules).action, "allow");
	assert.equal(findRule("sam@proton.me", rules).action, "block");
	assert.equal(findRule("x@29.lucktaro.com", rules).action, "block");
	assert.equal(findRule("x@ok.lucktaro.com", rules).action, "allow");
	assert.equal(findRule("automator42+3@gmail.com", rules).action, "block");
	assert.equal(findRule("automator43@gmail.com", rules), null);
	assert.equal(
		findRule("a@b.com", [
			{ kind: "domain", value: "b.com", action: "block" },
			{ kind: "domain", value: "b.com", action: "allow" },
		]).action,
		"allow"
	);
});

test("subdomains of a listed domain are listed, but never a bare suffix", () => {
	assert.deepEqual(getDomainCandidates("29.lucktaro.com"), ["29.lucktaro.com", "lucktaro.com"]);
	assert.deepEqual(getDomainCandidates("example.co.uk"), ["example.co.uk", "co.uk"]);
	const list = parseDomainList("# comment\nlucktaro.com\n\n  Playfine.com \n");
	assert.equal(list.size, 2);
	assert.ok(isListed("29.lucktaro.com", list));
	assert.ok(isListed("playfine.com", list));
	assert.ok(!isListed("gmail.com", list));
});

test("a refused check carries the sentence a signup form shows", () => {
	assert.equal(stripTag("a+b+c@x.com"), "a@x.com");
	assert.match(getCheckMessage("disposable"), /Disposable email addresses aren't accepted/);
	assert.match(getCheckMessage("no_mail_server", "gmial.com"), /^gmial\.com can't receive email/);
	assert.equal(getCheckMessage(null), null);
	assert.deepEqual(toCheckResult("a@x.com", null), { email: "a@x.com", accepted: true, reason: null, message: null });
	const refused = toCheckResult("a@lugiz.com", "disposable", { source: "verifymail" });
	assert.equal(refused.accepted, false);
	assert.equal(refused.source, "verifymail");
});
