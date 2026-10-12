import { isPlainObject } from "./validation.js";

// Contact properties and event properties: what our apps tell Mailcheap about a person or an event.
export const MAX_PROPERTIES = 50;
export const MAX_PROPERTY_VALUE_LENGTH = 500;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isValue(value) {
	if (typeof value === "string") return value.length <= MAX_PROPERTY_VALUE_LENGTH;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "boolean";
}

// Strings, numbers and booleans (dates go as ISO strings). For contacts, null removes a property.
export function readProperties(input, { allowNull = false } = {}) {
	if (input === undefined) return { properties: {} };
	if (!isPlainObject(input)) return { error: "properties must be an object" };
	const entries = Object.entries(input);
	if (entries.length > MAX_PROPERTIES) return { error: `properties can have at most ${MAX_PROPERTIES} keys` };
	for (const [key, value] of entries) {
		if (!KEY_PATTERN.test(key)) {
			return { error: `property names start with a letter and use letters, digits and _ (64 at most): ${key.slice(0, 70)}` };
		}
		if (!(isValue(value) || (allowNull && value === null))) {
			return {
				error: `${key} must be a string (${MAX_PROPERTY_VALUE_LENGTH} characters at most), a number or a boolean${allowNull ? ", or null to remove it" : ""}`,
			};
		}
	}
	return { properties: Object.fromEntries(entries) };
}

export function isEventName(value) {
	return typeof value === "string" && EVENT_NAME_PATTERN.test(value);
}

// The properties an update changed, with their old and new values (null when absent).
export function changedProperties(before = {}, after = {}) {
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	return [...keys]
		.filter((key) => !Object.is(before?.[key] ?? null, after?.[key] ?? null))
		.map((key) => ({ key, from: before?.[key] ?? null, to: after?.[key] ?? null }));
}
