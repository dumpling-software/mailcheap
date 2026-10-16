import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Columns are snake_case in Postgres (casing: "snake_case" in lib/db.js and drizzle.config.js) and
// camelCase in code. The primary key keeps the _id name the app has always used.
const id = () => uuid("id").primaryKey().defaultRandom();
const at = (name) => timestamp(name, { withTimezone: true, mode: "date" });
const timestamps = () => ({
	createdAt: at("created_at").notNull().defaultNow(),
	updatedAt: at("updated_at")
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});
// Where an imported row came from (e.g. "mailerlite" and its id there), so imports can run again.
const external = () => ({ externalSource: text(), externalId: text() });

const CAMPAIGN_STATS = { recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, unsubscribed: 0, failed: 0 };
const LAST_CHANCE_STATS = { recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, dormant: 0 };
const CONTACT_STATS = { sent: 0, opens: 0, clicks: 0 };

export const newsletters = pgTable(
	"newsletters",
	{
		_id: id(),
		name: text().notNull(),
		slug: text().notNull(),
		imageUrl: text(),
		fromName: text(),
		fromEmail: text().notNull(),
		replyTo: text(),
		postalAddress: text(),
		archiveEnabled: boolean().notNull().default(false),
		description: text(),
		socialLinks: text().array().notNull().default(sql`'{}'::text[]`),
		// { bio, imageUrl }: the archive's author page; the author's name is fromName.
		author: jsonb().notNull().default({}),
		// New signups get an email with a link and only join once they click it (confirmed opt-in).
		requireConfirmation: boolean().notNull().default(false),
		// { enabled, issues, days }, checked when an issue is sent (lib/cleanup.js).
		cleanup: jsonb().notNull().default({}),
		// { enabled, subject, previewText, markdown }
		welcome: jsonb().notNull().default({}),
		// { subject, previewText, markdown }: the built-in confirmation email goes out until it has one.
		confirmation: jsonb().notNull().default({}),
		// { layout, css }: the product's email design (lib/email-template.js); null uses the built-in one.
		template: jsonb(),
		...external(),
		...timestamps(),
	},
	(t) => [
		uniqueIndex("newsletters_slug_key").on(t.slug),
		uniqueIndex("newsletters_external_key").on(t.externalSource, t.externalId),
	]
);

// pending: signed up to a newsletter that asks new subscribers to confirm, and hasn't yet.
// Every status is per newsletter: one person is one contact in each newsletter they joined.
export const contacts = pgTable(
	"contacts",
	{
		_id: id(),
		newsletterId: uuid()
			.notNull()
			.references(() => newsletters._id),
		email: text().notNull(),
		status: text().notNull().default("active"),
		source: text(),
		subscribedAt: at("subscribed_at").defaultNow(),
		confirmedAt: at("confirmed_at"),
		unsubscribedAt: at("unsubscribed_at"),
		// A spam complaint about this newsletter's email: status complained, for this newsletter only.
		complainedAt: at("complained_at"),
		lastSentAt: at("last_sent_at"),
		lastOpenAt: at("last_open_at"),
		lastClickAt: at("last_click_at"),
		// List cleanup (lib/cleanup.js): issues received since the last sign of life, when that was, and
		// when the last-chance email went out.
		ignoredIssues: integer(),
		lastEngagedAt: at("last_engaged_at"),
		lastChanceAt: at("last_chance_at"),
		stats: jsonb().notNull().default(CONTACT_STATS),
		// From an import: engagement on the previous platform ({ emailsReceived, openRate, clickRate }).
		imported: jsonb(),
		// What the apps know about the person (plan, name, company...): strings, numbers, booleans and
		// ISO dates, set through the API (lib/properties.js) and read by automation conditions.
		properties: jsonb().notNull().default({}),
		...external(),
		...timestamps(),
	},
	(t) => [
		uniqueIndex("contacts_newsletter_email_key").on(t.newsletterId, t.email),
		index("contacts_email_idx").using("btree", t.email.op("text_pattern_ops")),
		index("contacts_newsletter_status_idx").on(t.newsletterId, t.status, t.subscribedAt.desc(), t._id.desc()),
		index("contacts_status_idx").on(t.status, t.subscribedAt.desc(), t._id.desc()),
		index("contacts_subscribed_idx").on(t.subscribedAt.desc(), t._id.desc()),
		index("contacts_newsletter_subscribed_idx").on(t.newsletterId, t.subscribedAt.desc(), t._id.desc()),
		index("contacts_last_chance_idx").on(t.newsletterId, t.lastChanceAt).where(sql`${t.lastChanceAt} is not null`),
		uniqueIndex("contacts_external_key").on(t.newsletterId, t.externalSource, t.externalId),
		index("contacts_properties_idx").using("gin", t.properties),
	]
);

// Something a contact did in one of our apps (api_key_created, plan_upgraded...), sent to
// POST /api/v1/events. Automations start from them and wait for them.
export const contactEvents = pgTable(
	"contact_events",
	{
		_id: id(),
		newsletterId: uuid()
			.notNull()
			.references(() => newsletters._id),
		contactId: uuid()
			.notNull()
			.references(() => contacts._id, { onDelete: "cascade" }),
		name: text().notNull(),
		properties: jsonb().notNull().default({}),
		occurredAt: at("occurred_at").notNull().defaultNow(),
		...timestamps(),
	},
	(t) => [index("contact_events_contact_name_idx").on(t.contactId, t.name, t.occurredAt.desc())]
);

export const campaigns = pgTable(
	"campaigns",
	{
		_id: id(),
		newsletterId: uuid()
			.notNull()
			.references(() => newsletters._id),
		subject: text().notNull().default(""),
		previewText: text().notNull().default(""),
		// rich: written in the editor, stored as an HTML fragment in html. html: a designed document sent
		// as is. markdown: written in Markdown.
		format: text().notNull().default("rich"),
		markdown: text().notNull().default(""),
		html: text().notNull().default(""),
		status: text().notNull().default("draft"),
		// Warm-up: send to the most engaged contacts first, capped at audienceLimit.
		audienceLimit: integer(),
		source: text().notNull().default("dashboard"),
		scheduledAt: at("scheduled_at"),
		startedAt: at("started_at"),
		sentAt: at("sent_at"),
		testSentAt: at("test_sent_at"),
		archiveSlug: text(),
		thumbnailUrl: text(),
		// Unlisted issues keep their /p/slug page but stay off the archive index.
		archiveListed: boolean().notNull().default(true),
		archivePinned: boolean().notNull().default(false),
		webViews: integer().notNull().default(0),
		stats: jsonb().notNull().default(CAMPAIGN_STATS),
		// The list cleanup at this send: last-chance emails sent instead of the issue, and contacts made dormant.
		lastChance: jsonb().notNull().default(LAST_CHANCE_STATS),
		...external(),
		...timestamps(),
	},
	(t) => [
		index("campaigns_newsletter_created_idx").on(t.newsletterId, t.createdAt.desc()),
		index("campaigns_status_idx").on(t.status),
		index("campaigns_started_idx").on(t.startedAt.desc()),
		uniqueIndex("campaigns_archive_slug_key").on(t.archiveSlug).where(sql`${t.archiveSlug} is not null`),
		uniqueIndex("campaigns_external_key").on(t.externalSource, t.externalId),
	]
);

export const messages = pgTable(
	"messages",
	{
		_id: id(),
		// Insertion order: audiences are inserted most engaged first and sent in that order.
		seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
		kind: text().notNull(),
		campaignId: uuid().references(() => campaigns._id),
		// Automation emails: the automation, the contact's run through it, and the send node.
		automationId: uuid().references(() => automations._id),
		enrollmentId: uuid().references(() => enrollments._id, { onDelete: "set null" }),
		nodeId: text(),
		newsletterId: uuid()
			.notNull()
			.references(() => newsletters._id),
		// Null once the contact is erased (GDPR): the message still counts in its campaign's stats.
		contactId: uuid().references(() => contacts._id, { onDelete: "set null" }),
		email: text().notNull(),
		provider: text(),
		status: text().notNull().default("queued"),
		sesMessageId: text(),
		error: text(),
		sentAt: at("sent_at"),
		deliveredAt: at("delivered_at"),
		openedAt: at("opened_at"),
		clickedAt: at("clicked_at"),
		bouncedAt: at("bounced_at"),
		complainedAt: at("complained_at"),
		...timestamps(),
	},
	(t) => [
		// One email per contact per campaign, even if a send job is retried.
		uniqueIndex("messages_campaign_contact_key")
			.on(t.campaignId, t.contactId)
			.where(sql`${t.kind} = 'campaign'`),
		// And at most one last-chance email per contact per send.
		uniqueIndex("messages_last_chance_key")
			.on(t.campaignId, t.contactId)
			.where(sql`${t.kind} = 'last-chance'`),
		// One email per send node per run through an automation, however often a job retries.
		uniqueIndex("messages_enrollment_node_key")
			.on(t.enrollmentId, t.nodeId)
			.where(sql`${t.kind} = 'automation'`),
		index("messages_automation_node_idx").on(t.automationId, t.nodeId).where(sql`${t.automationId} is not null`),
		index("messages_ses_message_idx").on(t.sesMessageId).where(sql`${t.sesMessageId} is not null`),
		index("messages_kind_created_idx").on(t.kind, t.createdAt.desc()),
		index("messages_newsletter_sent_idx").on(t.newsletterId, t.sentAt),
		index("messages_campaign_status_idx").on(t.campaignId, t.status, t.kind, t.seq),
		index("messages_contact_idx").on(t.contactId),
	]
);

// Only problem events are stored (see lib/ses-events.js); deliveries and engagement live on messages.
export const events = pgTable(
	"events",
	{
		_id: id(),
		type: text().notNull(),
		sesMessageId: text(),
		messageId: uuid(),
		campaignId: uuid(),
		email: text(),
		occurredAt: at("occurred_at").notNull().defaultNow(),
		data: jsonb(),
		...timestamps(),
	},
	(t) => [index("events_campaign_type_idx").on(t.campaignId, t.type), index("events_ses_message_idx").on(t.sesMessageId)]
);

// Email other apps send over SES SMTP with the transactional configuration set (login links,
// notifications), one row per SES message, built from its events (lib/transactional.js).
export const transactionalMessages = pgTable(
	"transactional_messages",
	{
		_id: id(),
		sesMessageId: text().notNull(),
		domain: text(),
		fromAddress: text(),
		email: text(),
		subject: text(),
		provider: text(),
		status: text().notNull().default("sent"),
		error: text(),
		sentAt: at("sent_at").notNull(),
		deliveredAt: at("delivered_at"),
		delayedAt: at("delayed_at"),
		bouncedAt: at("bounced_at"),
		complainedAt: at("complained_at"),
		...timestamps(),
	},
	(t) => [
		uniqueIndex("transactional_messages_ses_message_key").on(t.sesMessageId),
		index("transactional_messages_sent_idx").on(t.sentAt),
		index("transactional_messages_domain_sent_idx").on(t.domain, t.sentAt),
	]
);

// Global: an address listed here is never emailed again from any newsletter. Only hard bounces (the
// address doesn't exist) and manual blocks: unsubscribes and spam complaints are per newsletter.
export const suppressions = pgTable(
	"suppressions",
	{
		_id: id(),
		email: text().notNull(),
		reason: text().notNull(),
		detail: text(),
		...timestamps(),
	},
	(t) => [uniqueIndex("suppressions_email_key").on(t.email)]
);

export const apiKeys = pgTable(
	"api_keys",
	{
		_id: id(),
		name: text().notNull(),
		prefix: text().notNull(),
		hash: text().notNull(),
		// A key for one newsletter (one product's app) can't touch the others. Null: every newsletter.
		newsletterId: uuid().references(() => newsletters._id),
		lastUsedAt: at("last_used_at"),
		revokedAt: at("revoked_at"),
		...timestamps(),
	},
	(t) => [uniqueIndex("api_keys_hash_key").on(t.hash)]
);

// One row per alert kind: lastSentAt enforces the cooldown between repeated alerts.
export const alerts = pgTable(
	"alerts",
	{
		_id: id(),
		key: text().notNull(),
		title: text(),
		lastSentAt: at("last_sent_at"),
		...timestamps(),
	},
	(t) => [uniqueIndex("alerts_key_key").on(t.key)]
);

// A drip sequence for one newsletter. nodes is a graph keyed by node id, entered at startNodeId:
// send, wait, wait_until, branch and exit nodes (lib/automations/schema.js).
export const automations = pgTable(
	"automations",
	{
		_id: id(),
		newsletterId: uuid()
			.notNull()
			.references(() => newsletters._id),
		name: text().notNull(),
		// draft: being written. active: enrolls and runs. paused: holds every contact where it is.
		status: text().notNull().default("draft"),
		trigger: jsonb().notNull().default({ type: "contact_added" }),
		// A condition that takes a contact out at any step (e.g. they made their first API call).
		exitWhen: jsonb(),
		startNodeId: text().notNull().default("start"),
		nodes: jsonb().notNull().default({}),
		// Can a contact go through again once they finished?
		allowReentry: boolean().notNull().default(false),
		pausedReason: text(),
		// Totals from an import (the previous platform's numbers).
		stats: jsonb().notNull().default({}),
		...external(),
		...timestamps(),
	},
	(t) => [
		index("automations_newsletter_status_idx").on(t.newsletterId, t.status),
		uniqueIndex("automations_external_key").on(t.externalSource, t.externalId),
	]
);

// One contact's run through an automation.
export const enrollments = pgTable(
	"enrollments",
	{
		_id: id(),
		automationId: uuid()
			.notNull()
			.references(() => automations._id),
		contactId: uuid()
			.notNull()
			.references(() => contacts._id, { onDelete: "cascade" }),
		// active: due to move on. waiting: in a wait or wait_until node. completed: reached the end. exited:
		// left early (exit condition, unsubscribe, deleted node...), see exitReason.
		status: text().notNull().default("active"),
		currentNodeId: text(),
		nextRunAt: at("next_run_at"),
		// The wait this run is in: { nodeId, until }.
		waitFor: jsonb(),
		// The event that started the run ({ name, properties }), for event_property conditions later on.
		triggerEvent: jsonb(),
		// Set while a job or an incoming event moves the run, so two never move it at once.
		lockedUntil: at("locked_until"),
		// Visited nodes: [{ nodeId, type, at, outcome }].
		history: jsonb().notNull().default([]),
		exitReason: text(),
		enrolledAt: at("enrolled_at").notNull().defaultNow(),
		finishedAt: at("finished_at"),
		...timestamps(),
	},
	(t) => [
		// A contact is in an automation at most once at a time.
		uniqueIndex("enrollments_live_key")
			.on(t.automationId, t.contactId)
			.where(sql`${t.status} in ('active', 'waiting')`),
		index("enrollments_due_idx").on(t.nextRunAt).where(sql`${t.status} in ('active', 'waiting')`),
		index("enrollments_contact_idx").on(t.contactId),
		index("enrollments_automation_status_idx").on(t.automationId, t.status),
	]
);
