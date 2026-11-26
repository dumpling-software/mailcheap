// Email topics a contact can opt out of one by one, while staying on the newsletter. Every campaign
// and automation belongs to one; contacts.unsubscribedTopics lists the ones a contact left (empty:
// subscribed to all of them). Unsubscribing from the whole newsletter is the contact's status.
export const PRODUCT_UPDATES = "product_updates";
export const AUTOMATIONS = "automations";
export const TOPICS = [PRODUCT_UPDATES, AUTOMATIONS];

export const DEFAULT_CAMPAIGN_TOPIC = PRODUCT_UPDATES;
export const DEFAULT_AUTOMATION_TOPIC = AUTOMATIONS;

export const TOPIC_LABELS = {
	[PRODUCT_UPDATES]: "Product updates",
	[AUTOMATIONS]: "Automated emails",
};

// Statuses that receive email; a topic only counts as subscribed with one of these.
const RECEIVING_STATUSES = ["active", "pending"];

export function isTopic(value) {
	return TOPICS.includes(value);
}

export function campaignTopic(campaign) {
	return isTopic(campaign?.topic) ? campaign.topic : DEFAULT_CAMPAIGN_TOPIC;
}

export function automationTopic(automation) {
	return isTopic(automation?.topic) ? automation.topic : DEFAULT_AUTOMATION_TOPIC;
}

export function isOptedOut(contact, topic) {
	return Boolean(topic) && (contact?.unsubscribedTopics ?? []).includes(topic);
}

// The effective subscription per topic, as the contacts API reports it.
export function getTopicSubscriptions(contact) {
	const receives = RECEIVING_STATUSES.includes(contact?.status);
	return Object.fromEntries(TOPICS.map((topic) => [topic, receives && !isOptedOut(contact, topic)]));
}

// The opt-out list after applying { topic: boolean } changes (false: opt out, true: opt back in), in
// TOPICS order so equal lists compare equal.
export function applyTopicChanges(unsubscribedTopics = [], changes = {}) {
	const out = new Set((unsubscribedTopics ?? []).filter(isTopic));
	for (const [topic, subscribed] of Object.entries(changes)) {
		if (!isTopic(topic)) continue;
		if (subscribed) out.delete(topic);
		else out.add(topic);
	}
	return TOPICS.filter((topic) => out.has(topic));
}
