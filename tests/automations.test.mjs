import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, evaluate, eventNamesIn, validateCondition } from "../lib/automations/conditions.js";
import { parseDuration, validateAutomation } from "../lib/automations/schema.js";
import { advance, afterSend, matchesTrigger } from "../lib/automations/step.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const later = (ms) => new Date(NOW.getTime() + ms);

// The reference example: a customer who hasn't used the API after a week gets asked if they need help.
const ONBOARDING = {
	name: "Onboarding nudge",
	trigger: { type: "event", name: "api_key_created" },
	exitWhen: { has_event: "first_api_call" },
	startNodeId: "start",
	nodes: {
		start: { type: "wait_until", condition: { has_event: "first_api_call" }, timeout: "7d", met: "end", timeout_next: "help" },
		help: { type: "send", subject: "Need a hand getting started?", markdown: "Hi! I noticed...", next: "wait2" },
		wait2: { type: "wait", duration: "4d", next: "check" },
		check: { type: "branch", condition: { not_has_event: "first_api_call" }, yes: "help2", no: "end" },
		help2: { type: "send", subject: "Quick question", markdown: "...", next: "end" },
		end: { type: "exit" },
	},
};

function context(overrides = {}) {
	return { contact: { status: "active", properties: {}, subscribedAt: new Date(NOW.getTime() - 10 * DAY) }, events: [], engagement: [], now: NOW, automationId: "a1", ...overrides };
}

// Runs advance and the sends it asks for, like run.js, until a wait or the end.
function run(automation, enrollment, ctx, now = NOW) {
	const sends = [];
	let state = { currentNodeId: enrollment.currentNodeId, waitFor: enrollment.waitFor, visited: [] };
	for (;;) {
		const { effect, state: next } = advance({ automation, enrollment: { ...enrollment, ...state }, context: { ...ctx, now }, now });
		state = { ...next, visited: [...state.visited, ...next.visited] };
		if (effect.type !== "send") return { effect, state, sends };
		sends.push(effect.nodeId);
		state = afterSend({ state, nodeId: effect.nodeId, next: effect.next, now });
	}
}

test("durations read minutes, hours, days and weeks", () => {
	assert.equal(parseDuration("30m"), 30 * 60_000);
	assert.equal(parseDuration("12h"), 12 * HOUR);
	assert.equal(parseDuration("7d"), 7 * DAY);
	assert.equal(parseDuration("2w"), 14 * DAY);
	for (const bad of ["", "7", "0d", "-1d", "1y", "400d", null]) assert.equal(parseDuration(bad), null, String(bad));
});

test("the reference automation is valid; broken graphs and loops aren't", () => {
	assert.deepEqual(validateAutomation(ONBOARDING), []);
	const errors = (changes) => validateAutomation({ ...ONBOARDING, nodes: { ...ONBOARDING.nodes, ...changes } }).join("\n");
	assert.match(errors({ help: { type: "send", subject: "", markdown: "x", next: "wait2" } }), /needs a subject/);
	assert.match(errors({ help: { type: "send", subject: "x", next: "wait2" } }), /needs markdown or html/);
	assert.match(errors({ wait2: { type: "wait", duration: "soon", next: "check" } }), /duration/);
	assert.match(errors({ check: { type: "branch", condition: { has_event: "x" }, yes: "nowhere" } }), /points to "nowhere"/);
	assert.match(errors({ orphan: { type: "exit" } }), /can't be reached/);
	assert.match(errors({ check: { type: "branch", condition: { has_event: "x" }, yes: "help2", no: "end" }, help2: { type: "send", subject: "x", markdown: "y", next: "check" } }), /loop needs a wait/);
	assert.deepEqual(errors({ help2: { type: "send", subject: "x", markdown: "y", next: "wait2" } }), "", "a loop through a wait is fine");
	assert.match(validateAutomation({ ...ONBOARDING, trigger: { type: "event" } }).join(), /event's name/);
	assert.match(validateAutomation({ ...ONBOARDING, startNodeId: "first" }).join(), /start node "first"/);
});

test("conditions compare properties as numbers, dates or text", () => {
	const ctx = context({ contact: { status: "active", properties: { plan: "pro", seats: "12", renews: "2026-11-01" } } });
	assert.equal(evaluate({ property: "plan", eq: "pro" }, ctx), true);
	assert.equal(evaluate({ property: "plan", neq: "free" }, ctx), true);
	assert.equal(evaluate({ property: "seats", gt: 9 }, ctx), true, "\"12\" > 9, not \"12\" < \"9\"");
	assert.equal(evaluate({ property: "renews", lt: "2026-12-01" }, ctx), true);
	assert.equal(evaluate({ property: "plan", contains: "PR" }, ctx), true);
	assert.equal(evaluate({ property: "missing", exists: false }, ctx), true);
	assert.equal(evaluate({ property: "missing", eq: "x" }, ctx), false);
	assert.equal(evaluate({ property: "missing", neq: "x" }, ctx), true);
	assert.equal(evaluate({ all: [{ property: "plan", eq: "pro" }, { not: { property: "seats", lt: 5 } }] }, ctx), true);
	assert.equal(evaluate({ any: [{ property: "plan", eq: "free" }, { status: "active" }] }, ctx), true);
	assert.equal(compare("eq", 3, "3"), true);
});

test("conditions read events, recent ones with within_days, and engagement", () => {
	const ctx = context({
		events: [{ name: "first_api_call", occurredAt: new Date(NOW.getTime() - 3 * DAY) }],
		engagement: [{ automationId: "a1", nodeId: "help", clickedAt: NOW, openedAt: NOW }, { campaignId: "c1", openedAt: NOW }],
	});
	assert.equal(evaluate({ has_event: "first_api_call" }, ctx), true);
	assert.equal(evaluate({ has_event: "first_api_call", within_days: 2 }, ctx), false);
	assert.equal(evaluate({ not_has_event: "quota_reached" }, ctx), true);
	assert.equal(evaluate({ clicked: { node: "help" } }, ctx), true);
	assert.equal(evaluate({ clicked: { campaign: "c1" } }, ctx), false);
	assert.equal(evaluate({ opened: { campaign: "c1" } }, ctx), true);
	assert.equal(evaluate({ signup_age_days: { gte: 7 } }, ctx), true);
	assert.deepEqual(eventNamesIn({ any: [{ has_event: "a" }, { not: { not_has_event: "b" } }] }), ["a", "b"]);
});

test("invalid conditions explain themselves", () => {
	assert.deepEqual(validateCondition({ has_event: "x", within_days: 7 }), []);
	assert.match(validateCondition({ property: "plan" }).join(), /needs one of/);
	assert.match(validateCondition({ all: [] }).join(), /needs a list/);
	assert.match(validateCondition({ clicked: {} }).join(), /needs \{ node \}/);
	assert.match(validateCondition({ whatever: 1 }).join(), /isn't a condition/);
	assert.match(validateCondition("x").join(), /must be an object/);
});

test("no API call within 7 days: the help email, 4 days later the second one", () => {
	const enrollment = { currentNodeId: "start", waitFor: null };
	const first = run(ONBOARDING, enrollment, context());
	assert.equal(first.effect.type, "wait");
	assert.equal(first.effect.until.getTime(), later(7 * DAY).getTime());
	assert.deepEqual(first.sends, []);

	const second = run(ONBOARDING, { ...enrollment, ...first.state }, context(), later(7 * DAY));
	assert.deepEqual(second.sends, ["help"]);
	assert.equal(second.effect.type, "wait");
	assert.equal(second.effect.until.getTime(), later(11 * DAY).getTime());

	const third = run(ONBOARDING, { ...enrollment, ...second.state }, context(), later(11 * DAY));
	assert.deepEqual(third.sends, ["help2"]);
	assert.equal(third.effect.type, "complete");
	assert.deepEqual(
		third.state.visited.map(({ nodeId, outcome }) => `${nodeId}${outcome ? `:${outcome}` : ""}`),
		["wait2:waited", "check:yes", "help2", "end"]
	);
});

test("waking early keeps waiting; the event arriving exits the run", () => {
	const waiting = run(ONBOARDING, { currentNodeId: "start" }, context());
	const woken = run(ONBOARDING, { currentNodeId: "start", ...waiting.state }, context(), later(DAY));
	assert.equal(woken.effect.type, "wait");
	assert.equal(woken.effect.until.getTime(), later(7 * DAY).getTime(), "the timeout doesn't move");

	const called = context({ events: [{ name: "first_api_call", occurredAt: later(2 * DAY) }] });
	const done = run(ONBOARDING, { currentNodeId: "start", ...waiting.state }, called, later(2 * DAY));
	assert.deepEqual(done.effect, { type: "exit", reason: "exit condition" });
	assert.deepEqual(done.sends, []);
});

test("wait_until moves to met when its condition holds, without exitWhen", () => {
	const automation = { ...ONBOARDING, exitWhen: null };
	const called = context({ events: [{ name: "first_api_call", occurredAt: NOW }] });
	const result = run(automation, { currentNodeId: "start" }, called);
	assert.equal(result.effect.type, "complete");
	assert.deepEqual(result.state.visited.map(({ nodeId, outcome }) => `${nodeId}:${outcome ?? ""}`), ["start:met", "end:"]);
});

test("branches go yes or no", () => {
	const automation = { ...ONBOARDING, exitWhen: null };
	const enrollment = { currentNodeId: "check" };
	assert.deepEqual(run(automation, enrollment, context()).sends, ["help2"]);
	const called = context({ events: [{ name: "first_api_call", occurredAt: NOW }] });
	assert.deepEqual(run(automation, enrollment, called).sends, []);
});

test("a contact who unsubscribed in the middle leaves before the next email", () => {
	const left = context({ contact: { status: "unsubscribed", properties: {} } });
	const result = run(ONBOARDING, { currentNodeId: "help" }, left);
	assert.deepEqual(result.effect, { type: "exit", reason: "contact unsubscribed" });
	assert.deepEqual(result.sends, []);
	assert.deepEqual(run(ONBOARDING, { currentNodeId: "help" }, context({ contact: null })).effect, { type: "exit", reason: "contact deleted" });
});

test("a run on a node that was deleted ends; a missing next completes it", () => {
	assert.deepEqual(run(ONBOARDING, { currentNodeId: "old-node" }, context()).effect, { type: "exit", reason: "node removed" });
	const short = { ...ONBOARDING, exitWhen: null, nodes: { start: { type: "send", subject: "Hi", markdown: "x" } } };
	const result = run(short, { currentNodeId: "start" }, context());
	assert.deepEqual(result.sends, ["start"]);
	assert.equal(result.effect.type, "complete");
});

test("a loop with no wait stops instead of spinning", () => {
	const loop = { nodes: { start: { type: "branch", condition: { status: "active" }, yes: "start" } }, startNodeId: "start" };
	assert.deepEqual(advance({ automation: loop, enrollment: {}, context: context(), now: NOW }).effect, {
		type: "exit",
		reason: "too many steps without a wait",
	});
});

test("triggers match their event, property change and condition", () => {
	const ctx = context({ contact: { status: "active", properties: { plan: "pro" } } });
	assert.equal(matchesTrigger({ type: "event", name: "api_key_created" }, { type: "event", eventName: "api_key_created", context: ctx }), true);
	assert.equal(matchesTrigger({ type: "event", name: "api_key_created" }, { type: "event", eventName: "other", context: ctx }), false);
	const upgrade = { type: "property_changed", property: "plan", to: "pro" };
	assert.equal(matchesTrigger(upgrade, { type: "property_changed", changes: [{ key: "plan", from: "free", to: "pro" }], context: ctx }), true);
	assert.equal(matchesTrigger(upgrade, { type: "property_changed", changes: [{ key: "plan", from: "pro", to: "free" }], context: ctx }), false);
	assert.equal(matchesTrigger({ type: "contact_added", condition: { property: "plan", eq: "free" } }, { type: "contact_added", context: ctx }), false);
});
