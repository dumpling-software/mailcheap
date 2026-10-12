import { evaluate } from "./conditions.js";
import { parseDuration } from "./schema.js";

// More nodes than this in one go is a loop (the editor refuses loops without a wait, but definitions
// can come from the API or an import).
const MAX_STEPS = 50;

// Walks an enrollment from where it is until something has to happen outside: an email to send, a
// wait, or the end. Pure, so every path is testable; lib/automations/run.js does what it returns.
//   effect.type "send":     send node effect.nodeId, then continue at effect.next
//   effect.type "wait":     come back at effect.until (or sooner, when an event wakes the run)
//   effect.type "complete": the run reached the end, or an exit node
//   effect.type "exit":     the run stops early, effect.reason says why
// state: the enrollment's new currentNodeId and waitFor, and the nodes visited on the way.
export function advance({ automation, enrollment, context, now = new Date() }) {
	const nodes = automation.nodes ?? {};
	// New runs start at startNodeId; null means the run is past its last node.
	let currentNodeId = enrollment.currentNodeId === undefined ? (automation.startNodeId ?? "start") : enrollment.currentNodeId;
	let waitFor = enrollment.waitFor ?? null;
	const visited = [];
	const at = now.toISOString();
	const result = (effect) => ({ effect, state: { currentNodeId, waitFor, visited } });
	const pass = (node, outcome, nextId) => {
		visited.push({ nodeId: currentNodeId, type: node.type, at, ...(outcome && { outcome }) });
		currentNodeId = nextId ?? null;
		waitFor = null;
	};

	for (let step = 0; step < MAX_STEPS; step++) {
		// Before every node, sends included: the exit condition, then the contact still being subscribed.
		if (automation.exitWhen && evaluate(automation.exitWhen, context)) return result({ type: "exit", reason: "exit condition" });
		const status = context.contact?.status;
		if (status !== "active") return result({ type: "exit", reason: status ? `contact ${status}` : "contact deleted" });
		if (!currentNodeId) return result({ type: "complete" });

		const node = nodes[currentNodeId];
		// Edited while the contact was in it: a node that's gone ends the run.
		if (!node) return result({ type: "exit", reason: "node removed" });

		switch (node.type) {
			case "exit":
				visited.push({ nodeId: currentNodeId, type: "exit", at });
				return result({ type: "complete" });
			case "send":
				return result({ type: "send", nodeId: currentNodeId, next: node.next ?? null });
			case "branch":
				if (evaluate(node.condition, context)) pass(node, "yes", node.yes);
				else pass(node, "no", node.no);
				break;
			case "wait": {
				if (waitFor?.nodeId !== currentNodeId) {
					waitFor = { nodeId: currentNodeId, until: new Date(now.getTime() + (parseDuration(node.duration) ?? 0)).toISOString() };
				}
				if (now.getTime() < Date.parse(waitFor.until)) return result({ type: "wait", until: new Date(waitFor.until) });
				pass(node, "waited", node.next);
				break;
			}
			case "wait_until": {
				if (evaluate(node.condition, context)) {
					pass(node, "met", node.met);
					break;
				}
				if (waitFor?.nodeId !== currentNodeId) {
					waitFor = { nodeId: currentNodeId, until: new Date(now.getTime() + (parseDuration(node.timeout) ?? 0)).toISOString() };
				}
				if (now.getTime() < Date.parse(waitFor.until)) return result({ type: "wait", until: new Date(waitFor.until) });
				pass(node, "timeout", node.timeout_next);
				break;
			}
			default:
				return result({ type: "exit", reason: `unknown node type ${node.type}` });
		}
	}
	return result({ type: "exit", reason: "too many steps without a wait" });
}

// After a send node's email went out (or was found already sent): the run moves to its next node.
export function afterSend({ state, nodeId, next, now = new Date() }) {
	return {
		currentNodeId: next,
		waitFor: null,
		visited: [...state.visited, { nodeId, type: "send", at: now.toISOString() }],
	};
}

// Does this trigger start a run for this contact? context.event is the incoming event, if any.
export function matchesTrigger(trigger, { type, eventName, changes = [], context }) {
	if (!trigger || trigger.type !== type) return false;
	if (type === "event" && trigger.name !== eventName) return false;
	if (type === "property_changed") {
		const change = changes.find(({ key }) => key === trigger.property);
		if (!change) return false;
		if (Object.hasOwn(trigger, "to") && String(change.to) !== String(trigger.to)) return false;
	}
	return trigger.condition ? evaluate(trigger.condition, context) : true;
}
