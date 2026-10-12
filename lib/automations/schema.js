import { isEventName } from "../properties.js";
import { isPlainObject } from "../validation.js";
import { validateCondition } from "./conditions.js";

// An automation is a graph of nodes keyed by id, entered at startNodeId:
//   send       { subject, previewText?, markdown | html, next? }       one email, then next
//   wait       { duration: "4d", next? }                                 a fixed pause
//   wait_until { condition, timeout: "7d", met?, timeout_next? }         until the condition holds (an event
//                                                                        arriving, a property changing), or the timeout
//   branch     { condition, yes?, no? }
//   exit       {}
// A missing next (or yes, no, met, timeout_next) ends the run there.
export const NODE_TYPES = ["send", "wait", "wait_until", "branch", "exit"];
export const TRIGGER_TYPES = ["contact_added", "event", "property_changed"];
export const AUTOMATION_STATUSES = ["draft", "active", "paused"];
const LINKS = { send: ["next"], wait: ["next"], wait_until: ["met", "timeout_next"], branch: ["yes", "no"], exit: [] };
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DURATION_PATTERN = /^(\d{1,5})\s*(m|min|h|d|w)$/i;
const UNIT_MS = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const MAX_NODES = 100;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 500_000;
// Longer waits than this are a typo (or belong in a campaign).
const MAX_DURATION_MS = 365 * UNIT_MS.d;

// "30m", "12h", "7d", "2w" in milliseconds, or null.
export function parseDuration(value) {
	const match = DURATION_PATTERN.exec(String(value ?? "").trim());
	if (!match) return null;
	const ms = Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
	return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
}

export function linksOf(node) {
	return (LINKS[node?.type] ?? []).map((key) => node[key]).filter(Boolean);
}

function validateTrigger(trigger) {
	if (!isPlainObject(trigger) || !TRIGGER_TYPES.includes(trigger.type)) {
		return [`trigger.type must be one of ${TRIGGER_TYPES.join(", ")}`];
	}
	const errors = [];
	if (trigger.type === "event" && !isEventName(trigger.name)) errors.push("an event trigger needs the event's name");
	if (trigger.type === "property_changed" && !(typeof trigger.property === "string" && trigger.property)) {
		errors.push("a property_changed trigger needs the property's name");
	}
	if (trigger.condition !== undefined) {
		errors.push(...validateCondition(trigger.condition).map((error) => `trigger.condition: ${error}`));
	}
	return errors;
}

function validateNode(id, node) {
	const at = `nodes.${id}`;
	if (!NODE_ID_PATTERN.test(id)) return [`${at}: ids use letters, digits, _ and - (64 at most)`];
	if (!isPlainObject(node) || !NODE_TYPES.includes(node.type)) return [`${at}.type must be one of ${NODE_TYPES.join(", ")}`];
	const errors = [];
	if (node.type === "send") {
		if (typeof node.subject !== "string" || !node.subject.trim()) errors.push(`${at} needs a subject`);
		else if (node.subject.length > MAX_SUBJECT_LENGTH) errors.push(`${at}.subject is over ${MAX_SUBJECT_LENGTH} characters`);
		const body = node.markdown?.trim() ? node.markdown : node.html;
		if (typeof body !== "string" || !body.trim()) errors.push(`${at} needs markdown or html content`);
		else if (body.length > MAX_BODY_LENGTH) errors.push(`${at} content is over 500 KB`);
	}
	if (node.type === "wait" && parseDuration(node.duration) === null) {
		errors.push(`${at}.duration must look like 30m, 12h, 4d or 2w`);
	}
	if (node.type === "wait_until") {
		if (parseDuration(node.timeout) === null) errors.push(`${at}.timeout must look like 30m, 12h, 4d or 2w`);
		errors.push(...validateCondition(node.condition).map((error) => `${at}.condition: ${error}`));
	}
	if (node.type === "branch") errors.push(...validateCondition(node.condition).map((error) => `${at}.condition: ${error}`));
	return errors;
}

// Every problem with a definition, as messages for the editor. Empty when it can run.
export function validateAutomation({ trigger, exitWhen, nodes, startNodeId = "start" } = {}) {
	const errors = [...validateTrigger(trigger)];
	if (exitWhen !== undefined && exitWhen !== null) {
		errors.push(...validateCondition(exitWhen).map((error) => `exitWhen: ${error}`));
	}
	if (!isPlainObject(nodes) || Object.keys(nodes).length === 0) return [...errors, "nodes needs at least one node"];
	const ids = Object.keys(nodes);
	if (ids.length > MAX_NODES) errors.push(`at most ${MAX_NODES} nodes`);
	if (!nodes[startNodeId]) errors.push(`the start node "${startNodeId}" doesn't exist`);

	for (const [id, node] of Object.entries(nodes)) {
		errors.push(...validateNode(id, node));
		for (const link of linksOf(node)) {
			if (!nodes[link]) errors.push(`nodes.${id} points to "${link}", which doesn't exist`);
		}
	}
	if (errors.length > 0) return errors;

	// Every node should be reachable, and no loop may run without a wait in it (it would never stop).
	const reached = new Set();
	const queue = [startNodeId];
	while (queue.length > 0) {
		const id = queue.shift();
		if (reached.has(id)) continue;
		reached.add(id);
		queue.push(...linksOf(nodes[id]));
	}
	for (const id of ids) if (!reached.has(id)) errors.push(`nodes.${id} can't be reached from "${startNodeId}"`);
	if (hasLoopWithoutWait(nodes)) errors.push("a loop needs a wait or wait_until node in it");
	return errors;
}

function hasLoopWithoutWait(nodes) {
	const instant = Object.fromEntries(
		Object.entries(nodes)
			.filter(([, node]) => !["wait", "wait_until"].includes(node.type))
			.map(([id, node]) => [id, linksOf(node).filter((link) => !["wait", "wait_until"].includes(nodes[link]?.type))])
	);
	const state = {};
	const visit = (id) => {
		if (state[id] === "done") return false;
		if (state[id] === "open") return true;
		state[id] = "open";
		const looped = (instant[id] ?? []).some(visit);
		state[id] = "done";
		return looped;
	};
	return Object.keys(instant).some(visit);
}
