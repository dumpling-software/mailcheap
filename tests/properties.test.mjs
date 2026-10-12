import assert from "node:assert/strict";
import { test } from "node:test";
import { changedProperties, isEventName, readProperties } from "../lib/properties.js";

test("properties are strings, numbers and booleans under simple names", () => {
	assert.deepEqual(readProperties({ plan: "pro", seats: 3, trial: false }), { properties: { plan: "pro", seats: 3, trial: false } });
	assert.deepEqual(readProperties(undefined), { properties: {} });
	assert.match(readProperties([]).error, /must be an object/);
	assert.match(readProperties({ "bad key": 1 }).error, /property names/);
	assert.match(readProperties({ nested: { a: 1 } }).error, /must be a string/);
	assert.match(readProperties({ big: "x".repeat(501) }).error, /500 characters/);
	assert.match(readProperties({ nan: Number.NaN }).error, /must be a string/);
	assert.match(readProperties(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]))).error, /at most 50/);
});

test("contacts can remove a property with null; events can't", () => {
	assert.deepEqual(readProperties({ plan: null }, { allowNull: true }), { properties: { plan: null } });
	assert.match(readProperties({ plan: null }).error, /must be a string/);
});

test("event names are short identifiers", () => {
	for (const name of ["api_key_created", "plan.upgraded", "checkout:done", "first-call", "A1"]) assert.equal(isEventName(name), true, name);
	for (const name of ["", "_x", "has space", "x".repeat(65), 42, null]) assert.equal(isEventName(name), false, String(name));
});

test("changed properties list what moved, with old and new values", () => {
	assert.deepEqual(changedProperties({ plan: "free", seats: 1 }, { plan: "pro", seats: 1, trial: true }), [
		{ key: "plan", from: "free", to: "pro" },
		{ key: "trial", from: null, to: true },
	]);
	assert.deepEqual(changedProperties({ plan: "free" }, {}), [{ key: "plan", from: "free", to: null }]);
	assert.deepEqual(changedProperties({}, {}), []);
});
