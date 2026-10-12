import "server-only";
import { Client } from "@upstash/qstash";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { sendAlert } from "@/lib/alerts";
import { assignArchiveSlug } from "@/lib/archive-slugs";
import { CLEANUP_FIELDS, addToPreview, emptyPreview, getCleanupSettings, splitAudience } from "@/lib/cleanup";
import { LIMITS, getAppUrl, isSendingEnabled } from "@/lib/config";
import { getConfirmUrl } from "@/lib/confirmation";
import { getConfirmationContent } from "@/lib/confirmation-content";
import { automations, campaigns, contacts, getDb, jsonIncrement, earlier, messages, newsletters, query, suppressions } from "@/lib/db";
import { getKeepUrl } from "@/lib/last-chance";
import { getLastChanceContent } from "@/lib/last-chance-content";
import { mailboxProvider } from "@/lib/providers";
import { sendSesEmail } from "@/lib/ses";
import {
	CAMPAIGN_MESSAGE_KINDS,
	MAX_BATCH_MESSAGES,
	MAX_CONSECUTIVE_FAILURES,
	SEND_BATCH_SIZE,
	TEST_CONTACT_ID,
	buildRecipientEmail,
	chunk,
	getCampaignPauseReason,
	getCampaignStatsPath,
	getFeedbackId,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWelcomeContent,
} from "@/lib/sending-rules";
import { isUuid, normalizeEmail } from "@/lib/validation";

export { buildRecipientEmail } from "@/lib/sending-rules";

const QUEUEABLE_STATUSES = ["draft", "scheduled", "paused"];
const INSERT_CHUNK_SIZE = 1000;
const PUBLISH_CHUNK_SIZE = 100;
const SEND_INTERVAL_MS = Math.ceil(1000 / LIMITS.sendRatePerSecond);
const WELCOME_WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_KINDS = ["welcome", "confirmation"];
// Emails from automations (lib/automations/run.js): one per send node per run, sent one by one.
const AUTOMATION_KIND = "automation";
// Their links have to work, so they go out clean: no tracking pixel or redirect.
const UNTRACKED_KINDS = new Set(["confirmation", "last-chance"]);
// Signing up again resends the confirmation, but a script can't make us mail an address over and over.
const MAX_CONFIRMATIONS_PER_CONTACT = 3;

let qstash;
let nextSendAt = 0;

function assertSendingEnabled() {
	if (!isSendingEnabled()) throw new Error("Sending is off");
}

export function getQStash() {
	if (!process.env.QSTASH_TOKEN) throw new Error("QStash is not configured (QSTASH_TOKEN)");
	qstash ??= new Client({ token: process.env.QSTASH_TOKEN });
	return qstash;
}

// Tests publish through a stand-in with the same publishJSON and batchJSON methods.
export function setQStash(value) {
	qstash = value;
}

function formatError(error) {
	return String(error?.message || error).slice(0, 500);
}

// Slots are reserved synchronously, so concurrent sends in one instance share the rate.
async function waitForSendSlot() {
	const now = Date.now();
	const sendAt = Math.max(now, nextSendAt);
	nextSendAt = sendAt + SEND_INTERVAL_MS;
	if (sendAt > now) await new Promise((resolve) => setTimeout(resolve, sendAt - now));
}

function getMessageTags(message) {
	const tags = [
		{ name: "message_id", value: String(message._id) },
		{ name: "kind", value: message.kind },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	if (message.automationId) tags.push({ name: "automation_id", value: String(message.automationId) });
	return tags;
}

async function deliver({ message, content, newsletter, contact }) {
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const email = buildRecipientEmail({
		campaign: content,
		newsletter,
		contact,
		messageId: UNTRACKED_KINDS.has(message.kind) ? null : message._id,
		confirmUrl: message.kind === "confirmation" ? getConfirmUrl(reference) : "",
		keepUrl: message.kind === "last-chance" ? getKeepUrl(reference) : "",
	});
	const feedbackId = getFeedbackId({
		campaignId: message.campaignId ?? message.automationId,
		kind: message.kind,
		newsletterSlug: newsletter.slug,
	});
	await waitForSendSlot();
	const { sesMessageId } = await sendSesEmail({
		...email,
		headers: { ...email.headers, "Feedback-ID": feedbackId },
		tags: getMessageTags(message),
	});
	return { sesMessageId, sentAt: new Date() };
}

// A send node's email, in the shape renderEmail reads. Markdown wins when the node has both (an imported
// HTML email converted in the editor).
export function getAutomationContent(node) {
	if (!node || node.type !== "send") return null;
	const isMarkdown = Boolean(node.markdown?.trim());
	return {
		format: isMarkdown ? "markdown" : "html",
		markdown: isMarkdown ? node.markdown : "",
		html: isMarkdown ? "" : (node.html ?? ""),
		subject: node.subject,
		previewText: node.previewText ?? "",
	};
}

function getMessageContent({ kind, newsletter, campaign, automation, nodeId }) {
	if (kind === AUTOMATION_KIND) return getAutomationContent(automation?.nodes?.[nodeId]);
	if (kind === "welcome") return getWelcomeContent(newsletter);
	if (kind === "confirmation") return newsletter ? getConfirmationContent(newsletter) : null;
	if (kind === "last-chance") return newsletter ? getLastChanceContent(newsletter) : null;
	return campaign;
}

// Welcome and confirmation emails share one cap per newsletter, so a signup flood can't burn its sending
// domain's reputation, and a flood on one newsletter doesn't hold up the others' signup emails.
async function countRecentSignupEmails(newsletter) {
	const [row] = await getDb()
		.select({ count: count() })
		.from(messages)
		.where(
			and(
				inArray(messages.kind, SIGNUP_KINDS),
				eq(messages.newsletterId, newsletter._id),
				gte(messages.createdAt, new Date(Date.now() - WELCOME_WINDOW_MS))
			)
		);
	return row.count;
}

async function alertSignupCap(newsletter) {
	await sendAlert({
		key: `welcome-cap:${newsletter.slug}`,
		title: "Signup emails capped",
		detail: `Over ${LIMITS.welcomeEmailsPer10Minutes} welcome and confirmation emails for ${newsletter.name} in 10 minutes. New signups get none until it slows down.`,
		path: "/contacts",
	});
}

async function findByIds(table, ids) {
	const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
	if (uniqueIds.length === 0) return new Map();
	const rows = await getDb().select().from(table).where(inArray(table._id, uniqueIds));
	return new Map(rows.map((row) => [String(row._id), row]));
}

async function findById(table, id) {
	const [row] = await getDb().select().from(table).where(eq(table._id, id));
	return row ?? null;
}

async function pauseCampaign(campaignId, reason) {
	const paused = await getDb()
		.update(campaigns)
		.set({ status: "paused" })
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending")))
		.returning({ _id: campaigns._id });
	if (paused.length === 0) return;
	await sendAlert({
		key: `campaign-paused-${campaignId}`,
		title: "Campaign paused",
		detail: reason,
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 1,
	});
}

async function pauseIfUnhealthy(campaignId) {
	const [campaign] = await getDb()
		.select({ stats: campaigns.stats, lastChance: campaigns.lastChance })
		.from(campaigns)
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending")));
	const reason = campaign ? getCampaignPauseReason(campaign.stats, campaign.lastChance) : null;
	if (reason) await pauseCampaign(campaignId, `${reason} is over the limit`);
	return Boolean(reason);
}

async function settleCampaign(campaignId) {
	if (await pauseIfUnhealthy(campaignId)) return;
	const db = getDb();
	const [queued] = await db
		.select({ _id: messages._id })
		.from(messages)
		.where(and(eq(messages.campaignId, campaignId), inArray(messages.kind, CAMPAIGN_MESSAGE_KINDS), eq(messages.status, "queued")))
		.limit(1);
	if (queued) return;
	// A campaign sent in steps keeps the date of its first step.
	await db
		.update(campaigns)
		.set({ status: "sent", sentAt: earlier(campaigns.sentAt, new Date()) })
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending")));
}

// The unique indexes skip contacts a retried or repeated step already has.
async function insertIgnoringDuplicates(rows) {
	if (rows.length === 0) return;
	await getDb().insert(messages).values(rows).onConflictDoNothing();
}

function toMessages(campaign, kind, contacts) {
	return contacts.map((contact) => ({
		kind,
		campaignId: campaign._id,
		newsletterId: campaign.newsletterId,
		contactId: contact._id,
		email: contact.email,
		provider: mailboxProvider(contact.email),
	}));
}

// Contacts this campaign already reached: an earlier step, or an attempt that stopped halfway.
async function findPreviousMessages(campaignId) {
	const rows = await getDb()
		.select({ contactId: messages.contactId, kind: messages.kind })
		.from(messages)
		.where(and(eq(messages.campaignId, campaignId), inArray(messages.kind, CAMPAIGN_MESSAGE_KINDS)));
	return new Map(rows.map(({ contactId, kind }) => [String(contactId), kind]));
}

function normalizeLimit(audienceLimit) {
	const limit = Number(audienceLimit);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// lib/audience.js AUDIENCE_SORT in SQL: most engaged first, missing values last.
const AUDIENCE_ORDER = sql`last_click_at desc nulls last, last_open_at desc nulls last,
	(imported->>'clickRate')::float8 desc nulls last, (imported->>'openRate')::float8 desc nulls last,
	created_at asc, id asc`;

// Active, unsuppressed contacts, most engaged first. The order is read once, up front: the walk makes
// contacts dormant as it goes, which would move a paged query's pages under it. With the list cleanup
// on, the limit counts issue recipients only, so it's applied while walking (lib/cleanup.js splitAudience).
async function findAudience({ campaign, settings, audienceLimit }) {
	const limit = normalizeLimit(audienceLimit);
	const ids = await query(sql`
		select id from ${contacts}
		where newsletter_id = ${campaign.newsletterId} and status = 'active'
			and not exists (select 1 from suppressions s where s.email = contacts.email)
		order by ${AUDIENCE_ORDER}
		${limit && !settings.enabled ? sql`limit ${limit}` : sql``}`);
	const previous = settings.enabled ? await findPreviousMessages(campaign._id) : new Map();
	return { contacts: loadInChunks(ids.map(({ id }) => id), settings), limit, previous };
}

async function* loadInChunks(ids, settings) {
	const fields = settings.enabled ? ["_id", ...CLEANUP_FIELDS] : ["_id", "email"];
	const columns = Object.fromEntries(fields.map((field) => [field, contacts[field]]));
	for (let index = 0; index < ids.length; index += INSERT_CHUNK_SIZE) {
		const chunkIds = ids.slice(index, index + INSERT_CHUNK_SIZE);
		const rows = await getDb().select(columns).from(contacts).where(inArray(contacts._id, chunkIds));
		const byId = new Map(rows.map((row) => [row._id, row]));
		yield chunkIds.map((id) => byId.get(id)).filter(Boolean);
	}
}

async function makeDormant(campaignId, dormant) {
	if (dormant.length === 0) return;
	const db = getDb();
	// A sign of life since the walk read them sets ignoredIssues back to 0: those contacts stay.
	const updated = await db
		.update(contacts)
		.set({ status: "dormant" })
		.where(
			and(
				inArray(
					contacts._id,
					dormant.map(({ _id }) => _id)
				),
				eq(contacts.status, "active"),
				sql`${contacts.ignoredIssues} > 0`
			)
		)
		.returning({ _id: contacts._id });
	if (updated.length > 0) {
		await db
			.update(campaigns)
			.set({ lastChance: jsonIncrement(campaigns.lastChance, { dormant: updated.length }) })
			.where(eq(campaigns._id, campaignId));
	}
}

async function insertCampaignMessages(campaign, newsletter) {
	const settings = getCleanupSettings(newsletter);
	const { contacts: audience, limit, previous } = await findAudience({ campaign, settings, audienceLimit: campaign.audienceLimit });
	const now = Date.now();
	let remaining = limit ?? Infinity;
	for await (const group of audience) {
		const split = splitAudience(group, { settings, limit: remaining, previous, now });
		await insertIgnoringDuplicates(toMessages(campaign, "campaign", split.issue));
		await insertIgnoringDuplicates(toMessages(campaign, "last-chance", split.lastChance));
		await makeDormant(campaign._id, split.dormant);
		remaining -= split.issue.length + split.received;
		if (remaining <= 0) break;
	}
}

// What the list cleanup would do at this send, for the send dialogs: one walk over the whole list.
export async function getCleanupPreview(campaignId) {
	if (!isUuid(String(campaignId))) throw new Error("Campaign not found");
	const campaign = await findById(campaigns, campaignId);
	if (!campaign) throw new Error("Campaign not found");
	const newsletter = await findById(newsletters, campaign.newsletterId);
	const settings = getCleanupSettings(newsletter);
	if (!settings.enabled) return { enabled: false };

	const { contacts: audience, previous } = await findAudience({ campaign, settings });
	const preview = emptyPreview();
	const now = Date.now();
	for await (const group of audience) addToPreview(preview, group, { settings, previous, now });
	return { enabled: true, ...preview };
}

async function countCampaignMessages(campaignId) {
	const rows = await getDb()
		.select({ kind: messages.kind, count: count() })
		.from(messages)
		.where(and(eq(messages.campaignId, campaignId), inArray(messages.kind, CAMPAIGN_MESSAGE_KINDS)))
		.groupBy(messages.kind);
	const counts = new Map(rows.map(({ kind, count: total }) => [kind, total]));
	return CAMPAIGN_MESSAGE_KINDS.map((kind) => counts.get(kind) ?? 0);
}

// Issues first; last-chance emails go to the least engaged addresses, after everyone else.
async function publishQueuedMessages(campaignId) {
	const queued = await getDb()
		.select({ _id: messages._id })
		.from(messages)
		.where(and(eq(messages.campaignId, campaignId), inArray(messages.kind, CAMPAIGN_MESSAGE_KINDS), eq(messages.status, "queued")))
		.orderBy(asc(messages.kind), asc(messages.seq));
	const url = `${getAppUrl()}/api/jobs/send-batch`;
	// One batch at a time per campaign; each batch spaces its own sends at sendRatePerSecond.
	const flowControl = {
		key: `campaign-${campaignId}`,
		parallelism: 1,
		rate: 1,
		period: `${Math.ceil(SEND_BATCH_SIZE / LIMITS.sendRatePerSecond)}s`,
	};
	const requests = chunk(
		queued.map(({ _id }) => String(_id)),
		SEND_BATCH_SIZE
	).map((messageIds) => ({ url, body: { messageIds }, flowControl }));

	for (const group of chunk(requests, PUBLISH_CHUNK_SIZE)) await getQStash().batchJSON(group);
	return requests.length;
}

// Draft or scheduled: selects the audience. Paused: resumes with the audience it already has.
export async function queueCampaign(campaignId) {
	assertSendingEnabled();
	if (!process.env.QSTASH_TOKEN) throw new Error("QStash is not configured (QSTASH_TOKEN)");
	if (!isUuid(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findById(campaigns, campaignId);
	if (!campaign) throw new Error("Campaign not found");
	if (!QUEUEABLE_STATUSES.includes(campaign.status)) {
		throw new Error(`Campaign is already ${campaign.status}`);
	}
	const newsletter = await findById(newsletters, campaign.newsletterId);
	const problem = getSendProblem({ campaign, newsletter });
	if (problem) throw new Error(problem);

	if (campaign.status !== "paused") await insertCampaignMessages(campaign, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign._id);
	if (recipients + lastChances === 0) throw new Error("No active contacts to send to");

	const started = await getDb()
		.update(campaigns)
		.set({
			status: "sending",
			stats: sql`${campaigns.stats} || jsonb_build_object('recipients', ${recipients}::int)`,
			lastChance: sql`${campaigns.lastChance} || jsonb_build_object('recipients', ${lastChances}::int)`,
			startedAt: earlier(campaigns.startedAt, new Date()),
		})
		.where(and(eq(campaigns._id, campaign._id), eq(campaigns.status, campaign.status)))
		.returning({ _id: campaigns._id });
	if (started.length === 0) throw new Error("The campaign changed, refresh and try again");

	try {
		await assignArchiveSlug({ campaign, newsletter });
		const batches = await publishQueuedMessages(campaign._id);
		if (batches === 0) await settleCampaign(campaign._id);
		return { recipients, batches };
	} catch (error) {
		await pauseCampaign(campaign._id, `queueing failed: ${formatError(error)}`);
		throw new Error(`Could not queue the campaign, it is paused: ${formatError(error)}`);
	}
}

// Sending in steps: a sent campaign goes to the next most engaged contacts. It takes the top of the
// audience again and the one-email-per-contact index skips everyone who already received it.
export async function sendToMoreContacts(campaignId, additional) {
	assertSendingEnabled();
	if (!process.env.QSTASH_TOKEN) throw new Error("QStash is not configured (QSTASH_TOKEN)");
	if (!isUuid(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findById(campaigns, campaignId);
	if (!campaign) throw new Error("Campaign not found");
	if (campaign.status !== "sent") throw new Error("Wait until the current step has gone out");
	const newsletter = await findById(newsletters, campaign.newsletterId);
	const problem = getSendProblem({ campaign, newsletter });
	if (problem) throw new Error(problem);

	const [sentSoFar, lastChancesSoFar] = await countCampaignMessages(campaign._id);
	const audienceLimit = getNextStepLimit({ sentSoFar, additional });
	await insertCampaignMessages({ ...campaign, audienceLimit }, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign._id);
	if (recipients === sentSoFar && lastChances === lastChancesSoFar) throw new Error("Everyone has received it already");

	const restarted = await getDb()
		.update(campaigns)
		.set({
			status: "sending",
			stats: sql`${campaigns.stats} || jsonb_build_object('recipients', ${recipients}::int)`,
			lastChance: sql`${campaigns.lastChance} || jsonb_build_object('recipients', ${lastChances}::int)`,
			audienceLimit: audienceLimit ?? null,
		})
		.where(and(eq(campaigns._id, campaign._id), eq(campaigns.status, "sent")))
		.returning({ _id: campaigns._id });
	if (restarted.length === 0) throw new Error("The campaign changed, refresh and try again");

	try {
		const batches = await publishQueuedMessages(campaign._id);
		if (batches === 0) await settleCampaign(campaign._id);
		return { added: recipients - sentSoFar, recipients, batches };
	} catch (error) {
		await pauseCampaign(campaign._id, `queueing failed: ${formatError(error)}`);
		throw new Error(`Could not queue the next step, the campaign is paused: ${formatError(error)}`);
	}
}

// Every issue counts toward the list cleanup until a sign of life sets the count back (lib/cleanup.js).
// Moves one of a campaign's counters: the issue's (stats) or the list cleanup's (lastChance).
function incrementCampaign(campaignId, kind, deltas) {
	const column = getCampaignStatsPath(kind);
	return getDb()
		.update(campaigns)
		.set({ [column]: jsonIncrement(campaigns[column], deltas) })
		.where(eq(campaigns._id, campaignId));
}

async function recordSent({ message, campaign, contact, sesMessageId, sentAt }) {
	const db = getDb();
	await db.update(messages).set({ sesMessageId, sentAt, error: null }).where(eq(messages._id, message._id));
	await Promise.all([
		campaign && incrementCampaign(campaign._id, message.kind, { sent: 1 }),
		db
			.update(contacts)
			.set({
				lastSentAt: sentAt,
				...(message.kind === "last-chance" && { lastChanceAt: sentAt }),
				stats: jsonIncrement(contacts.stats, { sent: 1 }),
				...(message.kind === "campaign" && { ignoredIssues: sql`coalesce(${contacts.ignoredIssues}, 0) + 1` }),
			})
			.where(eq(contacts._id, contact._id)),
	]);
}

async function recordFailed({ message, campaign, error }) {
	await getDb().update(messages).set({ status: "failed", error: formatError(error) }).where(eq(messages._id, message._id));
	if (campaign) await incrementCampaign(campaign._id, message.kind, { failed: 1 });
}

function setMessageStatus(messageId, from, to, extra = {}) {
	return getDb()
		.update(messages)
		.set({ status: to, ...extra })
		.where(and(eq(messages._id, messageId), eq(messages.status, from)))
		.returning({ _id: messages._id });
}

// At most once per message: the queued -> sent claim happens before SES is called.
export async function sendMessageBatch(messageIds) {
	assertSendingEnabled();
	const ids = [
		...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id).toLowerCase())),
	]
		.filter(isUuid)
		.slice(0, MAX_BATCH_MESSAGES);
	const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0, retry: false };
	if (ids.length === 0) return result;

	const db = getDb();
	const order = new Map(ids.map((id, index) => [id, index]));
	const batch = (
		await db
			.select()
			.from(messages)
			.where(
				and(
					inArray(messages._id, ids),
					eq(messages.status, "queued"),
					inArray(messages.kind, [...CAMPAIGN_MESSAGE_KINDS, ...SIGNUP_KINDS, AUTOMATION_KIND])
				)
			)
	).sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
	result.skipped = ids.length - batch.length;
	if (batch.length === 0) return result;

	const [campaignsById, automationsById, newslettersById, contactsById, suppressedRows] = await Promise.all([
		findByIds(campaigns, batch.map(({ campaignId }) => campaignId)),
		findByIds(automations, batch.map(({ automationId }) => automationId)),
		findByIds(newsletters, batch.map(({ newsletterId }) => newsletterId)),
		findByIds(contacts, batch.map(({ contactId }) => contactId)),
		db
			.select({ email: suppressions.email })
			.from(suppressions)
			.where(inArray(suppressions.email, [...new Set(batch.map(({ email }) => email))])),
	]);
	const suppressed = new Set(suppressedRows.map(({ email }) => email));
	for (const campaignId of campaignsById.keys()) await pauseIfUnhealthy(campaignId);

	let consecutiveFailures = 0;
	for (const message of batch) {
		if (!isSendingEnabled()) {
			result.retry = true;
			break;
		}
		const campaign = campaignsById.get(String(message.campaignId)) ?? null;
		const isCampaignSending =
			!CAMPAIGN_MESSAGE_KINDS.includes(message.kind) || (await isStillSending(message.campaignId));
		if (!isCampaignSending) {
			result.skipped++;
			continue;
		}

		const contact = contactsById.get(String(message.contactId));
		const requiredStatus = message.kind === "confirmation" ? "pending" : "active";
		if (contact?.status !== requiredStatus || suppressed.has(message.email)) {
			await setMessageStatus(message._id, "queued", "suppressed");
			result.suppressed++;
			continue;
		}

		const claim = await setMessageStatus(message._id, "queued", "sent", { provider: mailboxProvider(message.email) });
		if (claim.length === 0) {
			result.skipped++;
			continue;
		}

		const newsletter = newslettersById.get(String(message.newsletterId));
		const content = getMessageContent({
			kind: message.kind,
			newsletter,
			campaign,
			automation: automationsById.get(String(message.automationId)),
			nodeId: message.nodeId,
		});
		let delivery;
		try {
			if (!newsletter || !content) throw new Error("Newsletter or email content not found");
			delivery = await deliver({ message, content, newsletter, contact });
		} catch (error) {
			// Automation emails wait and try again on throttling or account problems: the run holds its place.
			const isRetryable = campaign || message.kind === AUTOMATION_KIND;
			const action = isRetryable ? getSendErrorAction(error) : "fail";
			if (action === "fail") {
				await recordFailed({ message, campaign, error });
				result.failed++;
				consecutiveFailures++;
				if (!campaign || consecutiveFailures < MAX_CONSECUTIVE_FAILURES) continue;
				await pauseCampaign(campaign._id, `${consecutiveFailures} sends failed in a row`);
				break;
			}
			await setMessageStatus(message._id, "sent", "queued");
			if (action === "pause" && campaign) await pauseCampaign(campaign._id, formatError(error));
			else result.retry = true;
			break;
		}

		await recordSent({ message, campaign, contact, ...delivery });
		result.sent++;
		consecutiveFailures = 0;
	}

	for (const campaignId of campaignsById.keys()) await settleCampaign(campaignId);
	return result;
}

async function isStillSending(campaignId) {
	const [campaign] = await getDb()
		.select({ _id: campaigns._id })
		.from(campaigns)
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending")));
	return Boolean(campaign);
}

async function sendTest({ content, newsletter, campaignId, to }) {
	const email = normalizeEmail(to);
	if (!email) throw new Error("The test email address is invalid");
	const problem = getSendProblem({ campaign: content, newsletter });
	if (problem) throw new Error(problem);

	const [message] = await getDb()
		.insert(messages)
		.values({ kind: "test", campaignId, newsletterId: newsletter._id, email, provider: mailboxProvider(email) })
		.returning();
	let delivery;
	try {
		delivery = await deliver({
			message,
			content: { ...content, subject: `[Test] ${content.subject}` },
			newsletter,
			contact: { _id: TEST_CONTACT_ID, email },
		});
	} catch (error) {
		await recordFailed({ message, campaign: null, error });
		throw error;
	}

	const { sesMessageId, sentAt } = delivery;
	await getDb().update(messages).set({ status: "sent", sesMessageId, sentAt }).where(eq(messages._id, message._id));
	return { messageId: String(message._id), sesMessageId, sentAt };
}

export async function sendTestEmail({ campaignId, to }) {
	assertSendingEnabled();
	if (!isUuid(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findById(campaigns, campaignId);
	if (!campaign) throw new Error("Campaign not found");
	const newsletter = await findById(newsletters, campaign.newsletterId);
	const result = await sendTest({ content: campaign, newsletter, campaignId: campaign._id, to });
	await getDb().update(campaigns).set({ testSentAt: result.sentAt }).where(eq(campaigns._id, campaign._id));
	return result;
}

// One send node of an automation, as saved, to the admin. Works for drafts and paused automations.
export async function sendAutomationTestEmail({ automationId, nodeId, to }) {
	assertSendingEnabled();
	if (!isUuid(String(automationId))) throw new Error("Automation not found");
	const automation = await findById(automations, automationId);
	if (!automation) throw new Error("Automation not found");
	const content = getAutomationContent(automation.nodes?.[nodeId]);
	if (!content) throw new Error("Save the email first");
	const newsletter = await findById(newsletters, automation.newsletterId);
	return sendTest({ content, newsletter, to });
}

// Sends the saved welcome email, whether or not it's switched on yet.
export async function sendWelcomeTestEmail({ newsletterId, to }) {
	assertSendingEnabled();
	if (!isUuid(String(newsletterId))) throw new Error("Newsletter not found");

	const newsletter = await findById(newsletters, newsletterId);
	if (!newsletter) throw new Error("Newsletter not found");
	const content = getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
	if (!content) throw new Error("Save a subject and content first");
	return sendTest({ content, newsletter, to });
}

export async function queueWelcomeEmail({ newsletter, contact }) {
	assertSendingEnabled();
	const content = getWelcomeContent(newsletter);
	if (!content) return { skipped: "welcome email is off" };
	if (contact?.status !== "active") return { skipped: "contact is not active" };

	const [isSuppressed, welcomes, recentWelcomes] = await Promise.all([
		isSuppressedEmail(contact.email),
		countContactMessages({ kind: "welcome", contactId: contact._id }),
		countRecentSignupEmails(newsletter),
	]);
	const hasWelcome = welcomes > 0;
	if (isSuppressed) return { skipped: "suppressed" };
	if (hasWelcome) return { skipped: "already sent" };
	if (recentWelcomes >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	const problem = getSendProblem({ campaign: content, newsletter });
	if (problem) {
		console.warn(`[sending] Welcome email for ${newsletter.slug} not sent: ${problem}`);
		return { skipped: problem };
	}
	return sendSignupEmail({ kind: "welcome", newsletter, contact });
}

export async function queueConfirmationEmail({ newsletter, contact }) {
	assertSendingEnabled();
	if (contact?.status !== "pending") return { skipped: "contact is not pending" };

	const [isSuppressed, sentToContact, recentToContact, recentSignupEmails] = await Promise.all([
		isSuppressedEmail(contact.email),
		countContactMessages({ kind: "confirmation", contactId: contact._id }),
		countContactMessages({ kind: "confirmation", contactId: contact._id, since: new Date(Date.now() - WELCOME_WINDOW_MS) }),
		countRecentSignupEmails(newsletter),
	]);
	const sentRecently = recentToContact > 0;
	if (isSuppressed) return { skipped: "suppressed" };
	if (sentRecently || sentToContact >= MAX_CONFIRMATIONS_PER_CONTACT) return { skipped: "already sent" };
	if (recentSignupEmails >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	return sendSignupEmail({ kind: "confirmation", newsletter, contact });
}

// One automation email: the message row is unique per run and node, so a retried job finds the one it
// made and never sends it twice. Answers what happened: sent, already (sent before), suppressed,
// failed or retry (throttled, or sending turned off).
export async function sendAutomationEmail({ automation, enrollment, nodeId, contact, newsletter }) {
	if (!isSendingEnabled()) return { status: "retry" };
	const db = getDb();
	const [inserted] = await db
		.insert(messages)
		.values({
			kind: AUTOMATION_KIND,
			automationId: automation._id,
			enrollmentId: enrollment._id,
			nodeId,
			newsletterId: newsletter._id,
			contactId: contact._id,
			email: contact.email,
			provider: mailboxProvider(contact.email),
		})
		.onConflictDoNothing()
		.returning({ _id: messages._id });
	const [message] = inserted
		? [inserted]
		: await db
				.select({ _id: messages._id, status: messages.status })
				.from(messages)
				.where(and(eq(messages.kind, AUTOMATION_KIND), eq(messages.enrollmentId, enrollment._id), eq(messages.nodeId, nodeId)));
	if (!message) return { status: "failed" };
	if (!inserted && message.status !== "queued") return { status: "already", messageId: message._id };

	const result = await sendMessageBatch([String(message._id)]);
	if (result.sent) return { status: "sent", messageId: message._id };
	if (result.retry) return { status: "retry", messageId: message._id };
	if (result.suppressed) return { status: "suppressed", messageId: message._id };
	return { status: result.failed ? "failed" : "already", messageId: message._id };
}

async function isSuppressedEmail(email) {
	const [row] = await getDb().select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, email));
	return Boolean(row);
}

async function countContactMessages({ kind, contactId, since }) {
	const [row] = await getDb()
		.select({ count: count() })
		.from(messages)
		.where(
			and(eq(messages.kind, kind), eq(messages.contactId, contactId), since ? gte(messages.createdAt, since) : undefined)
		);
	return row.count;
}

async function sendSignupEmail({ kind, newsletter, contact }) {
	const [message] = await getDb()
		.insert(messages)
		.values({
			kind,
			newsletterId: newsletter._id,
			contactId: contact._id,
			email: contact.email,
			provider: mailboxProvider(contact.email),
		})
		.returning({ _id: messages._id });
	return { messageId: String(message._id), ...(await sendMessageBatch([String(message._id)])) };
}
