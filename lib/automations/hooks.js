import "server-only";
import { startAutomations, wakeContact } from "@/lib/automations/run";

// Where contacts and events reach the automations (lib/automations/run.js). The CSV and MailerLite
// imports never call these: imported contacts don't start automations.

// A new active contact (signup, API, an app event), or a pending one confirming.
export async function onContactCreated({ newsletter, contact }) {
	return startAutomations({ newsletter, contact, type: "contact_added" });
}

// An app event: starts the automations it triggers, then wakes the contact's waiting runs.
export async function onEvent({ newsletter, contact, event }) {
	const started = await startAutomations({ newsletter, contact, type: "event", eventName: event.name, event });
	const woken = await wakeContact(contact._id);
	return { started, woken };
}

export async function onPropertiesChanged({ newsletter, contact, changes }) {
	const started = await startAutomations({ newsletter, contact, type: "property_changed", changes });
	const woken = await wakeContact(contact._id);
	return { started, woken };
}
