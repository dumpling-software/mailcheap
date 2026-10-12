// MailerLite (connect.mailerlite.com) data in Mailcheap's shape. Pure, so the import's rules are tested
// on real payloads (tests/mailerlite.test.mjs); scripts/mailerlite/import.mjs does the fetching and writing.
//
// Groups are products and become newsletters. MailerLite's statuses are per account, Mailcheap's per
// newsletter: an unsubscribe is placed in the newsletter whose campaign it came from (attribution), a
// spam report ("junk") stays in the subscriber's newsletters, and only a hard bounce is global.

export const SOURCE = "mailerlite";
const PROPERTY_RENAMES = { z_i_p: "zip" };
const MAX_PROPERTY_LENGTH = 500;
const UNIT_SUFFIX = { minutes: "m", minute: "m", hours: "h", hour: "h", days: "d", day: "d", weeks: "w", week: "w" };
// Mailcheap's status order: an import never moves a contact back to a weaker one.
export const STATUS_RANK = { pending: -1, active: 0, dormant: 1, unsubscribed: 2, bounced: 3, complained: 4 };

// "2025-01-22 01:16:30" (UTC) as a Date, or null.
export function toDate(value) {
	if (!value || typeof value !== "string") return null;
	const date = new Date(`${value.trim().replace(" ", "T")}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? "" : "Z"}`);
	return Number.isFinite(date.getTime()) ? date : null;
}

// MailerLite rates are percentages (12.5) or { float: 0.125 }; Mailcheap keeps 0..1.
function toRate(value) {
	if (value && typeof value === "object" && Number.isFinite(value.float)) return value.float;
	const number = Number(value);
	return Number.isFinite(number) ? Math.round((number / 100) * 10_000) / 10_000 : undefined;
}

export function toProperties(fields) {
	return Object.fromEntries(
		Object.entries(fields ?? {})
			.filter(([, value]) => value !== null && value !== undefined && value !== "")
			.map(([key, value]) => [PROPERTY_RENAMES[key] ?? key, typeof value === "string" ? value.slice(0, MAX_PROPERTY_LENGTH) : value])
			.filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
	);
}

// The newsletters a subscriber belongs to, among the groups being imported.
function memberships(subscriber, groupSlugs) {
	return [...new Set((subscriber.groups ?? []).map(({ id }) => groupSlugs[String(id)]).filter(Boolean))];
}

// One subscriber, as contacts (one per newsletter) and maybe a global suppression.
//   attribution: Set of newsletter slugs whose campaigns this address unsubscribed from.
// Returns { contacts: [{ slug, values }], suppression, note } — note explains a judgment call for the report.
export function mapSubscriber(subscriber, { groupSlugs, attribution = new Set() }) {
	const email = String(subscriber.email ?? "").trim().toLowerCase();
	const slugs = memberships(subscriber, groupSlugs);
	const base = {
		email,
		source: SOURCE,
		subscribedAt: toDate(subscriber.subscribed_at) ?? toDate(subscriber.created_at),
		confirmedAt: toDate(subscriber.opted_in_at),
		properties: toProperties(subscriber.fields),
		imported: {
			emailsReceived: Number(subscriber.sent) || 0,
			...(toRate(subscriber.open_rate) !== undefined && { openRate: toRate(subscriber.open_rate) }),
			...(toRate(subscriber.click_rate) !== undefined && { clickRate: toRate(subscriber.click_rate) }),
		},
		externalId: String(subscriber.id),
	};
	const left = toDate(subscriber.unsubscribed_at) ?? toDate(subscriber.updated_at);
	const contact = (slug, status, extra = {}) => ({ slug, values: { ...base, status, ...extra } });

	switch (subscriber.status) {
		case "active":
			return { contacts: slugs.map((slug) => contact(slug, "active")), suppression: null };
		case "unconfirmed":
			return { contacts: slugs.map((slug) => contact(slug, "pending")), suppression: null };
		case "junk":
			return { contacts: slugs.map((slug) => contact(slug, "complained", { complainedAt: left })), suppression: null };
		case "bounced":
			return {
				contacts: slugs.map((slug) => contact(slug, "bounced")),
				suppression: { email, reason: "bounce", detail: SOURCE },
			};
		case "unsubscribed": {
			const unsubscribed = (slug) => contact(slug, "unsubscribed", { unsubscribedAt: left });
			if (slugs.length === 0) {
				// No group left (a deleted product, e.g. Spell): kept only where a campaign shows they left, so
				// signing up there again doesn't quietly resubscribe them.
				return { contacts: [...attribution].map(unsubscribed), suppression: null, note: attribution.size ? null : "no group" };
			}
			if (slugs.length === 1) return { contacts: [unsubscribed(slugs[0])], suppression: null };
			const from = slugs.filter((slug) => attribution.has(slug));
			// In several products and no trace of which one they left: the safe choice is all of them.
			if (from.length === 0) return { contacts: slugs.map(unsubscribed), suppression: null, note: "unattributed" };
			return {
				contacts: slugs.map((slug) => (from.includes(slug) ? unsubscribed(slug) : contact(slug, "active"))),
				suppression: null,
			};
		}
		default:
			return { contacts: [], suppression: null, note: `status ${subscriber.status}` };
	}
}

// The groups a campaign went to, from its filter ([[{ operator, args: ["groups", [ids]] }]]).
export function campaignGroupIds(campaign) {
	return (campaign.filter ?? [])
		.flat()
		.filter((rule) => Array.isArray(rule?.args) && rule.args[0] === "groups" && /^in_/.test(rule.operator ?? "in_any"))
		.flatMap((rule) => (Array.isArray(rule.args[1]) ? rule.args[1] : []))
		.map(String);
}

export function campaignNewsletter(campaign, groupSlugs) {
	return campaignGroupIds(campaign).map((id) => groupSlugs[id]).find(Boolean) ?? null;
}

// Which newsletter a campaign belongs to: the group it went to. A segment campaign goes to the
// newsletter most of its recipients are in (bySegment: the importer counts them). Campaigns for other
// groups (Spell) or for everyone are skipped.
export function campaignTarget(campaign, groupSlugs) {
	const slug = campaignNewsletter(campaign, groupSlugs);
	if (slug) return { slug };
	const rules = (campaign.filter ?? []).flat();
	const isSegment = rules.some((rule) => /segment/i.test(rule?.operator ?? "") || rule?.args?.[0] === "segments");
	if (isSegment && campaignGroupIds(campaign).length === 0) return { slug: null, bySegment: true };
	return { skip: true };
}

export function mapCampaign(campaign) {
	const email = campaign.emails?.[0] ?? {};
	const stats = campaign.stats ?? {};
	const isSent = campaign.status === "sent";
	const variants = (campaign.emails ?? []).slice(1).map(({ subject }) => subject).filter(Boolean);
	return {
		subject: email.subject ?? campaign.name ?? "",
		previewText: email.preheader ?? "",
		format: "html",
		status: isSent ? "sent" : "draft",
		source: variants.length ? `${SOURCE} (A/B: ${variants.join(" | ")})` : SOURCE,
		startedAt: isSent ? (toDate(campaign.started_at) ?? toDate(campaign.finished_at)) : null,
		sentAt: isSent ? toDate(campaign.finished_at) : null,
		stats: {
			recipients: stats.sent ?? 0,
			sent: stats.sent ?? 0,
			delivered: stats.deliveries_count ?? 0,
			opened: stats.opens_count ?? 0,
			clicked: stats.clicks_count ?? 0,
			unsubscribed: stats.unsubscribes_count ?? 0,
			bounced: stats.hard_bounces_count ?? 0,
			complained: stats.spam_count ?? 0,
			failed: 0,
		},
		externalId: String(campaign.id),
		previewUrl: email.preview_url ?? null,
		fromName: email.from_name ?? null,
		fromEmail: email.from ?? null,
		replyTo: email.reply_to ?? null,
	};
}

// One row of a campaign's subscriber-activity report as a sent message. MailerLite gives counts, not
// times: opens and clicks get the send time. A click counts as an open, as in Mailcheap.
export function mapActivity(row, { campaignId, newsletterId, contactId, sentAt, bounced }) {
	const clicked = Number(row.clicks_count) > 0;
	const opened = clicked || Number(row.opens_count) > 0;
	return {
		kind: "campaign",
		campaignId,
		newsletterId,
		contactId,
		email: String(row.subscriber_email ?? row.subscriber?.email ?? "").toLowerCase(),
		status: bounced ? "bounced" : "delivered",
		sentAt,
		deliveredAt: bounced ? null : sentAt,
		bouncedAt: bounced ? sentAt : null,
		openedAt: opened && !bounced ? sentAt : null,
		clickedAt: clicked && !bounced ? sentAt : null,
	};
}

// MailerLite automation steps form a chain through parent_id. Returns the steps in order, or the problem
// (a fork from a condition step) for the report.
export function orderSteps(steps) {
	const byParent = new Map();
	for (const step of steps ?? []) {
		const parent = step.parent_id ? String(step.parent_id) : null;
		byParent.set(parent, [...(byParent.get(parent) ?? []), step]);
	}
	const ordered = [];
	let parent = null;
	while (byParent.has(parent)) {
		const children = byParent.get(parent);
		if (children.length > 1) return { steps: ordered, problem: `step ${parent ?? "start"} has ${children.length} next steps` };
		ordered.push(children[0]);
		parent = String(children[0].id);
	}
	if (ordered.length !== (steps ?? []).length) return { steps: ordered, problem: "some steps aren't connected to the start" };
	return { steps: ordered, problem: null };
}

// An automation as Mailcheap nodes: emails become send nodes (their HTML is filled in from the preview
// URL by the importer), delays become waits.
export function mapAutomation(automation, { groupSlugs }) {
	const trigger = automation.triggers?.[0] ?? {};
	const slug = (trigger.group_ids ?? []).map((id) => groupSlugs[String(id)]).find(Boolean) ?? null;
	const { steps, problem } = orderSteps(automation.steps);
	const problems = problem ? [problem] : [];
	if (trigger.type !== "subscriber_joins_group") problems.push(`trigger ${trigger.type} isn't supported`);

	const counters = {};
	const ids = steps.map((step) => {
		const kind = step.type === "email" ? "email" : step.type === "delay" ? "wait" : step.type;
		counters[kind] = (counters[kind] ?? 0) + 1;
		return `${kind}-${counters[kind]}`;
	});
	const nodes = {};
	const emails = [];
	steps.forEach((step, index) => {
		const id = ids[index];
		const next = ids[index + 1];
		if (step.type === "email") {
			nodes[id] = { type: "send", subject: step.subject ?? step.email?.subject ?? "", previewText: step.preheader ?? step.email?.preheader ?? "", html: "", ...(next && { next }) };
			emails.push({ nodeId: id, previewUrl: step.email?.preview_url ?? null });
		} else if (step.type === "delay") {
			const unit = UNIT_SUFFIX[String(step.unit ?? "").toLowerCase()];
			if (!unit) problems.push(`delay ${step.id} has unit ${step.unit}`);
			nodes[id] = { type: "wait", duration: `${Number(step.value) || 1}${unit ?? "d"}`, ...(next && { next }) };
		} else {
			problems.push(`step type ${step.type} isn't supported`);
		}
	});
	const stats = automation.stats ?? {};
	return {
		slug,
		values: {
			name: automation.name,
			status: "draft",
			trigger: { type: "contact_added" },
			startNodeId: ids[0] ?? "start",
			nodes,
			allowReentry: false,
			stats: {
				imported: {
					completed: stats.completed_subscribers_count ?? 0,
					queued: stats.subscribers_in_queue_count ?? 0,
					sent: stats.sent ?? 0,
					wasEnabled: Boolean(automation.enabled),
				},
			},
			externalId: String(automation.id),
		},
		emails,
		problems,
	};
}
