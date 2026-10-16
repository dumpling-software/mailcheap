import { isUuid, isPlainObject, normalizeAddress } from "./validation.js";

const DETAIL_KEYS = new Map([
	["Send", "send"],
	["Delivery", "delivery"],
	["Bounce", "bounce"],
	["Complaint", "complaint"],
	["Open", "open"],
	["Click", "click"],
	["Reject", "reject"],
	["DeliveryDelay", "deliveryDelay"],
	["RenderingFailure", "failure"],
]);

// SES never un-delivers: later events only move a message to a worse status.
const BEFORE_DELIVERY = ["queued", "sent", "failed"];
const BEFORE_BOUNCE = [...BEFORE_DELIVERY, "delivered"];
const BEFORE_COMPLAINT = [...BEFORE_BOUNCE, "bounced"];

const OPEN = { field: "openedAt", stat: "opened", contactStat: "opens" };
const CLICK = { field: "clickedAt", stat: "clicked", contactStat: "clicks" };

// Configuration-set event publishing uses eventType; identity notifications use notificationType.
export function getSesEventType(sesEvent) {
	const type = String(sesEvent?.eventType ?? sesEvent?.notificationType ?? "").replace(" ", "");
	return DETAIL_KEYS.has(type) ? type : null;
}

function toDate(value) {
	const date = value ? new Date(value) : null;
	return date && Number.isFinite(date.getTime()) ? date : null;
}

function readTag(tags, name) {
	if (!isPlainObject(tags) || !Object.hasOwn(tags, name)) return null;
	const value = Array.isArray(tags[name]) ? tags[name][0] : tags[name];
	return isUuid(value) ? value.toLowerCase() : null;
}

function readText(tags, name) {
	if (!isPlainObject(tags) || !Object.hasOwn(tags, name)) return null;
	const value = Array.isArray(tags[name]) ? tags[name][0] : tags[name];
	return typeof value === "string" && value ? value : null;
}

function readRecipients(recipients, fallback) {
	const emails = (Array.isArray(recipients) ? recipients : [])
		.map((recipient) => normalizeAddress(recipient?.emailAddress))
		.filter(Boolean);
	if (emails.length > 0) return [...new Set(emails)];
	return fallback ? [fallback] : [];
}

function isUnsubscribeLink(link) {
	try {
		const url = new URL(link);
		return /^\/(api\/)?unsubscribe\/?$/.test(url.pathname) && url.searchParams.has("token");
	} catch {
		return false;
	}
}

// A click implies an open: the reader may have images blocked.
function engagementOf(type, occurredAt) {
	return type === "Click"
		? { firsts: [OPEN, CLICK], engagement: { lastOpenAt: occurredAt, lastClickAt: occurredAt } }
		: { firsts: [OPEN], engagement: { lastOpenAt: occurredAt } };
}

// Opens and clicks from Mailcheap's own pixel and links (lib/tracking.js).
export function getTrackingPlan(type, occurredAt = new Date()) {
	return { type, occurredAt, status: null, error: null, suppression: null, ...engagementOf(type, occurredAt) };
}

function withoutMailHeaders(sesEvent) {
	if (!isPlainObject(sesEvent.mail)) return sesEvent;
	const mail = { ...sesEvent.mail };
	delete mail.headers;
	return { ...sesEvent, mail };
}

// Transactional mail (login links, notifications) comes from other apps over SES SMTP, with the
// transactional configuration set as its identity's default. It has no message here: the event itself
// is the record.
const TRANSACTIONAL_STATUSES = {
	Send: "sent",
	DeliveryDelay: "delayed",
	Delivery: "delivered",
	Reject: "failed",
	RenderingFailure: "failed",
	Complaint: "complained",
};
const TRANSACTIONAL_FIELDS = {
	Delivery: "deliveredAt",
	DeliveryDelay: "delayedAt",
	Complaint: "complainedAt",
};

function getTransactional(type, mail, plan) {
	const bounced = type === "Bounce" && plan.suppression;
	const status = bounced ? "bounced" : type === "Complaint" && !plan.complaint ? null : TRANSACTIONAL_STATUSES[type];
	const field = bounced ? "bouncedAt" : status && TRANSACTIONAL_FIELDS[type];
	const subject = mail.commonHeaders?.subject;
	return {
		domain: readText(mail.tags, "ses:from-domain") ?? normalizeAddress(mail.source)?.split("@")[1] ?? null,
		fromAddress: normalizeAddress(mail.source),
		subject: typeof subject === "string" ? subject.slice(0, 300) : null,
		sentAt: toDate(mail.timestamp) ?? plan.occurredAt,
		status: status ?? "sent",
		field: field || null,
	};
}

// Pure: turns one SES event into the updates handleSesEvent applies, so the mapping is testable.
// Events from the transactional configuration set also get plan.transactional.
export function getSesEventPlan(sesEvent, { transactionalSet = null } = {}) {
	const type = getSesEventType(sesEvent);
	if (!type) return null;

	const mail = isPlainObject(sesEvent.mail) ? sesEvent.mail : {};
	const detail = isPlainObject(sesEvent[DETAIL_KEYS.get(type)]) ? sesEvent[DETAIL_KEYS.get(type)] : {};
	const email = normalizeAddress(Array.isArray(mail.destination) ? mail.destination[0] : null);
	const plan = {
		type,
		sesMessageId: typeof mail.messageId === "string" && mail.messageId ? mail.messageId : null,
		messageId: readTag(mail.tags, "message_id"),
		email,
		occurredAt: toDate(detail.timestamp) ?? toDate(mail.timestamp) ?? new Date(),
		firsts: [],
		status: null,
		error: null,
		engagement: null,
		suppression: null,
		complaint: null,
		data: withoutMailHeaders(sesEvent),
	};

	if (type === "Delivery") {
		plan.firsts = [{ field: "deliveredAt", stat: "delivered" }];
		plan.status = { to: "delivered", from: BEFORE_DELIVERY };
	}

	if (type === "Bounce") {
		const kind = detail.bounceType === "Permanent" ? "Hard" : "Soft";
		const reason = [detail.bounceSubType, detail.bouncedRecipients?.[0]?.diagnosticCode];
		plan.error = `${kind} bounce: ${reason.filter(Boolean).join(", ") || "unknown"}`;
		if (kind === "Hard") {
			plan.firsts = [{ field: "bouncedAt", stat: "bounced" }];
			plan.status = { to: "bounced", from: BEFORE_BOUNCE };
			plan.suppression = {
				emails: readRecipients(detail.bouncedRecipients, email),
				reason: "bounce",
				detail: `${detail.bounceType}/${detail.bounceSubType ?? "General"}`,
				contactStatus: "bounced",
				contactStatusFrom: ["active", "dormant", "unsubscribed"],
			};
		}
	}

	// "not-spam" is a recipient taking the email out of spam, not a complaint. A complaint is about one
	// newsletter: it stops that newsletter's emails, like an unsubscribe, and the address stays on the
	// others. Only hard bounces (the address doesn't exist) suppress it everywhere.
	if (type === "Complaint" && detail.complaintFeedbackType !== "not-spam") {
		plan.firsts = [{ field: "complainedAt", stat: "complained" }];
		plan.status = { to: "complained", from: BEFORE_COMPLAINT };
		plan.complaint = {
			emails: readRecipients(detail.complainedRecipients, email),
			detail: detail.complaintFeedbackType ?? "abuse",
			contactStatusFrom: ["active", "dormant", "pending", "unsubscribed", "bounced"],
		};
	}

	// Unsubscribe clicks aren't engagement.
	if (type === "Open" || (type === "Click" && !isUnsubscribeLink(detail.link))) {
		Object.assign(plan, engagementOf(type, plan.occurredAt));
	}

	if (type === "Reject" || type === "RenderingFailure") {
		plan.status = { to: "failed", from: ["queued", "sent"], stat: "failed" };
		plan.error =
			type === "Reject"
				? `Rejected by SES: ${detail.reason ?? "unknown"}`
				: `Rendering failed: ${detail.errorMessage ?? "unknown"}`;
	}

	if (transactionalSet && readText(mail.tags, "ses:configuration-set") === transactionalSet) {
		plan.transactional = getTransactional(type, mail, plan);
	}

	return plan;
}
