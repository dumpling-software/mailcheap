import { isPlainObject } from "../validation.js";

// Conditions are small JSON predicates, used by triggers, exitWhen, wait_until and branch nodes:
//   { all: [...] }  { any: [...] }  { not: {...} }
//   { property: "plan", eq: "pro" }       also neq, gt, gte, lt, lte, contains, exists: true|false
//   { has_event: "first_api_call", within_days?: 7 }   { not_has_event: "...", within_days?: 7 }
//   { event_property: "plan", eq: "pro" }  the properties of the event that started the run (event triggers)
//   { clicked: { node: "help" } }  { clicked: { campaign: "<id>" } }  { clicked: { any: true } }
//   { opened: {...} }   same shapes; opens are unreliable (Apple Mail loads every image), prefer clicks
//   { status: "active" }  { source: "api" }  { signup_age_days: { gte: 7 } }
// Evaluated against a context: { contact, events, engagement, event, automationId, now }.
const COMPARISONS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"];
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function toNumber(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function toTime(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
		const time = Date.parse(value);
		return Number.isFinite(time) ? time : null;
	}
	return null;
}

// Numbers compare as numbers ("3" equals 3), ISO dates as dates, everything else as strings.
function comparable(left, right) {
	const [a, b] = [toNumber(left), toNumber(right)];
	if (a !== null && b !== null) return [a, b];
	const [x, y] = [toTime(left), toTime(right)];
	if (x !== null && y !== null) return [x, y];
	return [String(left), String(right)];
}

export function compare(operator, actual, expected) {
	if (operator === "contains") {
		if (Array.isArray(actual)) return actual.some((item) => compare("eq", item, expected));
		return actual != null && String(actual).toLowerCase().includes(String(expected).toLowerCase());
	}
	if (actual === undefined || actual === null) return operator === "neq" && expected !== null;
	const [a, b] = comparable(actual, expected);
	switch (operator) {
		case "eq":
			return a === b;
		case "neq":
			return a !== b;
		case "gt":
			return a > b;
		case "gte":
			return a >= b;
		case "lt":
			return a < b;
		case "lte":
			return a <= b;
		default:
			return false;
	}
}

function matchValue(condition, actual) {
	if (Object.hasOwn(condition, "exists")) return (actual !== undefined && actual !== null) === Boolean(condition.exists);
	const operator = COMPARISONS.find((key) => Object.hasOwn(condition, key));
	return operator ? compare(operator, actual, condition[operator]) : false;
}

function hasEvent(context, name, withinDays) {
	const since = Number.isFinite(withinDays) ? context.now.getTime() - withinDays * DAY_MS : -Infinity;
	return (context.events ?? []).some(
		(event) => event.name === name && new Date(event.occurredAt).getTime() >= since
	);
}

function engaged(context, field, target) {
	const rows = (context.engagement ?? []).filter((row) => row[field]);
	if (!isPlainObject(target) || target.any) return rows.length > 0;
	if (target.node) {
		return rows.some((row) => row.nodeId === target.node && row.automationId === (target.automation ?? context.automationId));
	}
	if (target.campaign) return rows.some((row) => row.campaignId === target.campaign);
	return false;
}

export function evaluate(condition, context) {
	if (!isPlainObject(condition)) return false;
	if (Array.isArray(condition.all)) return condition.all.every((part) => evaluate(part, context));
	if (Array.isArray(condition.any)) return condition.any.some((part) => evaluate(part, context));
	if (Object.hasOwn(condition, "not")) return !evaluate(condition.not, context);
	if (typeof condition.property === "string") return matchValue(condition, context.contact?.properties?.[condition.property]);
	if (typeof condition.event_property === "string") {
		return matchValue(condition, context.event?.properties?.[condition.event_property]);
	}
	if (typeof condition.has_event === "string") return hasEvent(context, condition.has_event, condition.within_days);
	if (typeof condition.not_has_event === "string") return !hasEvent(context, condition.not_has_event, condition.within_days);
	if (Object.hasOwn(condition, "clicked")) return engaged(context, "clickedAt", condition.clicked);
	if (Object.hasOwn(condition, "opened")) return engaged(context, "openedAt", condition.opened);
	if (Object.hasOwn(condition, "status")) {
		const statuses = Array.isArray(condition.status) ? condition.status : [condition.status];
		return statuses.includes(context.contact?.status);
	}
	if (Object.hasOwn(condition, "source")) return compare("eq", context.contact?.source, condition.source);
	if (isPlainObject(condition.signup_age_days)) {
		const joined = new Date(context.contact?.subscribedAt ?? context.contact?.createdAt ?? Number.NaN).getTime();
		if (!Number.isFinite(joined)) return false;
		return matchValue(condition.signup_age_days, (context.now.getTime() - joined) / DAY_MS);
	}
	return false;
}

// What's wrong with a condition, for the editor. Empty when it's valid.
export function validateCondition(condition, path = "") {
	const at = path || "condition";
	if (!isPlainObject(condition)) return [`${at} must be an object`];
	for (const group of ["all", "any"]) {
		if (Object.hasOwn(condition, group)) {
			if (!Array.isArray(condition[group]) || condition[group].length === 0) return [`${at}.${group} needs a list of conditions`];
			return condition[group].flatMap((part, index) => validateCondition(part, `${at}.${group}[${index}]`));
		}
	}
	if (Object.hasOwn(condition, "not")) return validateCondition(condition.not, `${at}.not`);
	const needsComparison = (key) =>
		Object.hasOwn(condition, "exists") || COMPARISONS.some((operator) => Object.hasOwn(condition, operator))
			? []
			: [`${at} needs one of ${[...COMPARISONS, "exists"].join(", ")} with ${key}`];
	if (Object.hasOwn(condition, "property")) {
		return typeof condition.property === "string" && condition.property ? needsComparison("property") : [`${at}.property must be a name`];
	}
	if (Object.hasOwn(condition, "event_property")) return needsComparison("event_property");
	for (const key of ["has_event", "not_has_event"]) {
		if (Object.hasOwn(condition, key)) {
			if (typeof condition[key] !== "string" || !condition[key]) return [`${at}.${key} must be an event name`];
			if (condition.within_days !== undefined && !(Number(condition.within_days) > 0)) return [`${at}.within_days must be a positive number`];
			return [];
		}
	}
	for (const key of ["clicked", "opened"]) {
		if (Object.hasOwn(condition, key)) {
			const target = condition[key];
			return isPlainObject(target) && (target.any || target.node || target.campaign)
				? []
				: [`${at}.${key} needs { node }, { campaign } or { any: true }`];
		}
	}
	if (Object.hasOwn(condition, "status") || Object.hasOwn(condition, "source")) return [];
	if (Object.hasOwn(condition, "signup_age_days")) {
		return isPlainObject(condition.signup_age_days) ? needsComparisonIn(condition.signup_age_days, `${at}.signup_age_days`) : [`${at}.signup_age_days must be an object like { gte: 7 }`];
	}
	return [`${at} isn't a condition this editor knows`];
}

function needsComparisonIn(condition, at) {
	return COMPARISONS.some((operator) => Object.hasOwn(condition, operator)) ? [] : [`${at} needs one of ${COMPARISONS.join(", ")}`];
}

// Event names a condition reads, so an incoming event knows which waiting runs to wake.
export function eventNamesIn(condition) {
	if (!isPlainObject(condition)) return [];
	if (Array.isArray(condition.all)) return condition.all.flatMap(eventNamesIn);
	if (Array.isArray(condition.any)) return condition.any.flatMap(eventNamesIn);
	if (Object.hasOwn(condition, "not")) return eventNamesIn(condition.not);
	return [condition.has_event, condition.not_has_event].filter((name) => typeof name === "string");
}
