import "server-only";

// Where contacts and events reach the automations (lib/automations/run.js). The CSV and MailerLite
// imports never call these: imported contacts don't start automations.
export async function onContactCreated() {}

export async function onEvent() {}

export async function onPropertiesChanged() {}
