// Imports a MailerLite account into Mailcheap: groups as newsletters, subscribers as contacts, sent
// campaigns with their per-subscriber activity, and automations as drafts.
//
//   npm run import:mailerlite -- <stage...|all|sync> [--dry-run] [--refresh]
//
// Stages, in order: newsletters, attribution, contacts, campaigns, content, activity, engagement, automations.
// `sync` is the catch-up run before and after the switch: every stage with fresh API data, bringing over what
// changed in MailerLite since (new subscribers, unsubscribes, bounces, campaign numbers, new campaigns).
// MailerLite's responses are cached in .import-cache: without --refresh (implied by sync), a run reads them
// from there.
// Needs MAILERLITE_API_KEY and DATABASE_URL (DIRECT_URL works better for long runs), and SUPABASE_URL
// with SUPABASE_SERVICE_ROLE_KEY to move images off MailerLite. Every write is an upsert keyed on
// MailerLite's ids, so running a stage again is safe; contacts only ever get stricter statuses, so a
// final run after the switch brings over late unsubscribes without undoing anything done in Mailcheap.
// Nothing here sends email or starts automations.
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import TurndownService from "turndown";
import { isImageStorageConfigured, putImage } from "../../lib/blob.js";
import { automations, campaigns, contacts, getDb, messages, newsletters, query, suppressions, timestamp } from "../../lib/db.js";
import { cleanMailerLiteHtml, replaceUrls } from "../../lib/mailerlite/html.js";
import {
	SOURCE,
	STATUS_RANK,
	campaignNewsletter,
	campaignTarget,
	mapActivity,
	mapAutomation,
	mapCampaign,
	mapSubscriber,
} from "../../lib/mailerlite/map.js";
import { mailboxProvider } from "../../lib/providers.js";
import { firstImageUrl } from "../../lib/thumbnail.js";
import { createClient } from "./client.mjs";

// The product groups to import (MailerLite group id -> newsletter slug). Spell isn't migrated.
const GROUPS = {
	"142494481993696777": "supadata",
	"177927987388221151": "poof",
	"128577143579871085": "gistly",
};
const NAMES = { supadata: "Supadata", poof: "Poof", gistly: "Gistly" };
const STAGES = ["newsletters", "attribution", "contacts", "campaigns", "content", "activity", "engagement", "automations"];
const SUBSCRIBER_STATUSES = ["active", "unsubscribed", "unconfirmed", "bounced", "junk"];
const BATCH = 1000;
const MAX_EMAIL_BYTES = 100_000;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const requested = args.filter((arg) => !arg.startsWith("--"));
const isSync = requested.includes("sync");
const stages = ["all", "sync"].some((name) => requested.includes(name)) || requested.length === 0 ? STAGES : requested;
for (const stage of stages) if (!STAGES.includes(stage)) throw new Error(`Unknown stage ${stage}. Stages: ${STAGES.join(", ")}, all`);

const ml = createClient({
	apiKey: process.env.MAILERLITE_API_KEY,
	cacheDir: path.resolve(".import-cache"),
	refresh: isSync || args.includes("--refresh"),
});
const report = { dryRun: isDryRun, stages, counts: {}, notes: {} };
const count = (key, amount = 1) => (report.counts[key] = (report.counts[key] ?? 0) + amount);
const note = (key, value) => (report.notes[key] = [...(report.notes[key] ?? []), value]);
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
turndown.remove(["style", "head", "title", "meta"]);

// ─── Shared lookups ──────────────────────────────────────────────────────────

let newsletterIds;
async function getNewsletterIds() {
	if (newsletterIds) return newsletterIds;
	const rows = await getDb()
		.select({ _id: newsletters._id, slug: newsletters.slug })
		.from(newsletters)
		.where(inArray(newsletters.slug, Object.values(GROUPS)));
	newsletterIds = Object.fromEntries(rows.map(({ slug, _id }) => [slug, _id]));
	return newsletterIds;
}

async function listCampaigns() {
	const all = [];
	for (const status of ["sent", "draft"]) {
		for await (const campaign of ml.pages(`campaigns?filter[status]=${status}`)) all.push(campaign);
	}
	return all;
}

function classifyCampaign(campaign) {
	return campaignTarget(campaign, GROUPS);
}

async function* activity(campaign, filter) {
	yield* ml.pages(`campaigns/${campaign.id}/reports/subscriber-activity${filter ? `?filter[type]=${filter}` : ""}`);
}

const imageCache = new Map();
// MailerLite's images stop loading when the account closes: they move to Supabase Storage.
async function rehost(html) {
	const { html: cleaned, imageUrls } = cleanMailerLiteHtml(html);
	if (imageUrls.length === 0 || isDryRun) return cleaned;
	if (!isImageStorageConfigured()) {
		count("images left on MailerLite (no SUPABASE_URL)", imageUrls.length);
		return cleaned;
	}
	const replacements = {};
	for (const url of imageUrls) {
		if (!imageCache.has(url)) {
			try {
				const bytes = await ml.download(url);
				const extension = (/\.(png|jpe?g|gif|webp)(?:$|\?)/i.exec(url)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
				const type = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[extension];
				imageCache.set(url, await putImage(`mailerlite/${path.basename(new URL(url).pathname)}`, bytes, type));
				count("images moved");
			} catch (error) {
				note("images that failed", `${url}: ${error.message}`);
				imageCache.set(url, url);
			}
		}
		replacements[url] = imageCache.get(url);
	}
	return replaceUrls(cleaned, replacements);
}

async function emailHtml(previewUrl, label) {
	if (!previewUrl) {
		note("emails without a preview", label);
		return "";
	}
	let source;
	try {
		source = (await ml.download(previewUrl)).toString("utf8");
	} catch (error) {
		// Drafts have no public preview: their content has to be copied over by hand.
		note("emails whose content couldn't be fetched (copy them by hand)", `${label}: ${error.message.slice(0, 60)}`);
		return "";
	}
	const html = await rehost(source);
	const bytes = Buffer.byteLength(html);
	if (bytes > MAX_EMAIL_BYTES) note("emails over 100 KB (Gmail clips them)", `${label}: ${Math.ceil(bytes / 1000)} KB`);
	return html;
}

// ─── Stages ──────────────────────────────────────────────────────────────────

async function stageNewsletters() {
	const groups = [];
	for await (const group of ml.pages("groups")) groups.push(group);
	const campaignList = await listCampaigns();
	for (const group of groups) {
		const slug = GROUPS[String(group.id)];
		if (!slug) {
			note("groups not imported", group.name);
			continue;
		}
		// From, from-name and reply-to: the group's latest campaign.
		const latest = campaignList
			.filter((campaign) => campaignNewsletter(campaign, GROUPS) === slug && campaign.emails?.[0]?.from)
			.sort((a, b) => String(b.finished_at ?? b.created_at).localeCompare(String(a.finished_at ?? a.created_at)))[0];
		const email = latest?.emails?.[0] ?? {};
		const values = {
			name: NAMES[slug] ?? group.name,
			slug,
			fromName: email.from_name ?? null,
			fromEmail: (email.from ?? `hello@${slug}.example`).toLowerCase(),
			replyTo: email.reply_to?.toLowerCase() ?? null,
			externalSource: SOURCE,
			externalId: String(group.id),
		};
		count("newsletters");
		log(`newsletter ${slug}: ${values.fromName ?? ""} <${values.fromEmail}>, ${group.active_count} active in MailerLite`);
		if (isDryRun) continue;
		const db = getDb();
		const [existing] = await db.select().from(newsletters).where(eq(newsletters.slug, slug));
		if (existing) {
			// Created by hand already: only fills in what's missing.
			await db
				.update(newsletters)
				.set({
					externalSource: SOURCE,
					externalId: String(group.id),
					...(!existing.fromName && values.fromName && { fromName: values.fromName }),
					...(!existing.replyTo && values.replyTo && { replyTo: values.replyTo }),
				})
				.where(eq(newsletters._id, existing._id));
		} else {
			await db.insert(newsletters).values(values);
			note("set the postal address in each newsletter's settings", slug);
		}
	}
	newsletterIds = null;
}

// email -> the newsletters whose campaigns they unsubscribed from.
async function loadAttribution() {
	const attribution = new Map();
	for (const campaign of (await listCampaigns()).filter((campaign) => campaign.status === "sent")) {
		const { slug, skip } = classifyCampaign(campaign);
		if (skip || !slug) continue;
		for await (const row of activity(campaign, "unsubscribed")) {
			const email = String(row.subscriber_email ?? row.subscriber?.email ?? "").toLowerCase();
			if (!attribution.has(email)) attribution.set(email, new Set());
			attribution.get(email).add(slug);
		}
	}
	return attribution;
}

let attributionCache;
async function getAttribution() {
	attributionCache ??= await loadAttribution();
	return attributionCache;
}

async function stageAttribution() {
	const attribution = await getAttribution();
	count("unsubscribes traced to a campaign", attribution.size);
	log(`${attribution.size} unsubscribed addresses traced to a product's campaign`);
}

const RANK_SQL = (column) =>
	sql.raw(`(case ${column} ${Object.entries(STATUS_RANK).map(([status, rank]) => `when '${status}' then ${rank}`).join(" ")} else 0 end)`);

async function upsertContacts(rows) {
	const values = sql.join(
		rows.map(
			({ newsletterId, values: v }) =>
				sql`(${newsletterId}::uuid, ${v.email}, ${v.status}, ${v.source}, ${timestamp(v.subscribedAt ?? new Date())}, ${timestamp(v.confirmedAt)}, ${timestamp(v.unsubscribedAt)}, ${timestamp(v.complainedAt)}, ${JSON.stringify(v.properties)}::jsonb, ${JSON.stringify(v.imported)}::jsonb, ${SOURCE}, ${v.externalId})`
		),
		sql`, `
	);
	// Statuses only get stricter (an unsubscribe in Mailcheap is never undone by MailerLite's data), the
	// earliest signup date wins, and properties set by the apps since win over MailerLite's fields.
	return query(sql`
		insert into contacts (newsletter_id, email, status, source, subscribed_at, confirmed_at, unsubscribed_at, complained_at, properties, imported, external_source, external_id)
		values ${values}
		on conflict (newsletter_id, email) do update set
			status = case when ${RANK_SQL("excluded.status")} > ${RANK_SQL("contacts.status")} then excluded.status else contacts.status end,
			subscribed_at = least(contacts.subscribed_at, excluded.subscribed_at),
			confirmed_at = coalesce(contacts.confirmed_at, excluded.confirmed_at),
			unsubscribed_at = coalesce(contacts.unsubscribed_at, excluded.unsubscribed_at),
			complained_at = coalesce(contacts.complained_at, excluded.complained_at),
			properties = excluded.properties || contacts.properties,
			imported = excluded.imported,
			external_source = coalesce(contacts.external_source, excluded.external_source),
			external_id = coalesce(contacts.external_id, excluded.external_id)
		returning (xmax = 0) as inserted`);
}

async function stageContacts() {
	const attribution = await getAttribution();
	const ids = isDryRun ? Object.fromEntries(Object.values(GROUPS).map((slug) => [slug, slug])) : await getNewsletterIds();
	for (const slug of Object.values(GROUPS)) if (!ids[slug]) throw new Error(`Run the newsletters stage first (no "${slug}")`);
	let pending = [];
	const suppressed = [];
	async function flush() {
		if (pending.length === 0 || isDryRun) return void (pending = []);
		const batch = pending;
		pending = [];
		try {
			const result = await upsertContacts(batch);
			count("contacts created", result.filter(({ inserted }) => inserted).length);
		} catch {
			// One bad row shouldn't lose a thousand: retry them one by one.
			for (const row of batch) {
				try {
					await upsertContacts([row]);
				} catch (rowError) {
					note("contacts that failed", `${row.values.email} (${row.slug}): ${rowError.message.slice(0, 120)}`);
				}
			}
		}
	}

	for (const status of SUBSCRIBER_STATUSES) {
		let seen = 0;
		for await (const subscriber of ml.cursor(`subscribers?filter[status]=${status}&include=groups`)) {
			seen++;
			const email = String(subscriber.email ?? "").toLowerCase();
			const result = mapSubscriber(subscriber, { groupSlugs: GROUPS, attribution: attribution.get(email) });
			if (result.note === "unattributed") note("unsubscribed from several products, kept unsubscribed in all", email);
			else if (result.note) count(`subscribers skipped (${result.note})`);
			if (result.suppression) suppressed.push(result.suppression);
			for (const contact of result.contacts) {
				count(`contacts ${contact.values.status} in ${contact.slug}`);
				pending.push({ slug: contact.slug, newsletterId: ids[contact.slug], values: contact.values });
				if (pending.length >= BATCH) await flush();
			}
		}
		log(`${seen} ${status} subscribers read`);
	}
	await flush();

	count("bounce suppressions", suppressed.length);
	if (!isDryRun) {
		for (let index = 0; index < suppressed.length; index += BATCH) {
			await getDb().insert(suppressions).values(suppressed.slice(index, index + BATCH)).onConflictDoNothing({ target: suppressions.email });
		}
	}
}

// A segment campaign belongs to the newsletter most of its recipients are in.
async function majorityNewsletter(campaign) {
	const emails = [];
	for await (const row of activity(campaign)) emails.push(String(row.subscriber_email ?? "").toLowerCase());
	if (isDryRun || emails.length === 0) return null;
	const ids = await getNewsletterIds();
	const tally = {};
	for (let index = 0; index < emails.length; index += BATCH) {
		const rows = await getDb()
			.select({ newsletterId: contacts.newsletterId })
			.from(contacts)
			.where(inArray(contacts.email, emails.slice(index, index + BATCH)));
		for (const { newsletterId } of rows) tally[newsletterId] = (tally[newsletterId] ?? 0) + 1;
	}
	const [winner] = Object.entries(tally).sort((a, b) => b[1] - a[1]);
	return Object.entries(ids).find(([, id]) => id === winner?.[0])?.[0] ?? null;
}

async function importedCampaigns() {
	return getDb()
		.select()
		.from(campaigns)
		.where(eq(campaigns.externalSource, SOURCE));
}

async function stageCampaigns() {
	const ids = isDryRun ? {} : await getNewsletterIds();
	for (const campaign of await listCampaigns()) {
		const kind = classifyCampaign(campaign);
		if (kind.skip) {
			note("campaigns skipped (other groups or everyone)", campaign.name);
			continue;
		}
		const slug = kind.slug ?? (await majorityNewsletter(campaign));
		if (kind.bySegment) note("segment campaigns placed by their recipients", `${campaign.name} -> ${slug ?? "(dry run)"}`);
		count(`campaigns ${campaign.status} in ${slug ?? "?"}`);
		if (isDryRun) continue;
		if (!ids[slug]) {
			note("campaigns without a newsletter", campaign.name);
			continue;
		}
		const { previewUrl: _p, fromName: _n, fromEmail: _f, replyTo: _r, externalId, ...values } = mapCampaign(campaign);
		const insert = getDb()
			.insert(campaigns)
			.values({ ...values, newsletterId: ids[slug], externalSource: SOURCE, externalId });
		// A draft is Mailcheap's to edit once it's here; sent ones only get MailerLite's latest numbers.
		if (campaign.status !== "sent") {
			await insert.onConflictDoNothing();
			continue;
		}
		await insert.onConflictDoUpdate({
				target: [campaigns.externalSource, campaigns.externalId],
				set: { newsletterId: ids[slug], subject: values.subject, previewText: values.previewText, stats: values.stats, sentAt: values.sentAt, startedAt: values.startedAt, source: values.source },
			});
	}
}

async function stageContent() {
	const byId = new Map((await listCampaigns()).map((campaign) => [String(campaign.id), campaign]));
	const rows = isDryRun ? [...byId.values()].filter((campaign) => !classifyCampaign(campaign).skip).map((campaign) => ({ externalId: String(campaign.id), subject: campaign.name })) : await importedCampaigns();
	for (const row of rows) {
		// Content is fetched (and its images moved) once: later runs leave it, and any edits, alone.
		if (row.html || row.markdown) {
			count("campaign emails already imported");
			continue;
		}
		const campaign = byId.get(row.externalId);
		const html = await emailHtml(mapCampaign(campaign).previewUrl, row.subject);
		count("campaign emails converted");
		if (isDryRun || !html) continue;
		await getDb()
			.update(campaigns)
			.set({ html, format: "html", thumbnailUrl: firstImageUrl({ format: "html", html }) })
			.where(eq(campaigns._id, row._id));
	}
}

async function stageActivity() {
	const byId = new Map((await listCampaigns()).map((campaign) => [String(campaign.id), campaign]));
	const rows = isDryRun ? [] : (await importedCampaigns()).filter(({ status }) => status === "sent");
	if (isDryRun) {
		for (const campaign of byId.values()) {
			if (campaign.status !== "sent" || classifyCampaign(campaign).skip) continue;
			count("activity rows", campaign.stats?.sent ?? 0);
		}
		log(`about ${report.counts["activity rows"]} activity rows, ${Math.ceil((report.counts["activity rows"] ?? 0) / 100)} requests`);
		return;
	}
	const db = getDb();
	for (const row of rows) {
		const campaign = byId.get(row.externalId);
		const sentAt = row.sentAt ?? row.startedAt;
		const bounced = new Set();
		for await (const bounce of activity(campaign, "hardbounced")) bounced.add(String(bounce.subscriber_email ?? "").toLowerCase());
		let page = [];
		let missing = 0;
		async function flush() {
			if (page.length === 0) return;
			const emails = page.map((entry) => String(entry.subscriber_email ?? "").toLowerCase());
			const found = await db
				.select({ _id: contacts._id, email: contacts.email })
				.from(contacts)
				.where(and(eq(contacts.newsletterId, row.newsletterId), inArray(contacts.email, emails)));
			const idByEmail = new Map(found.map(({ email, _id }) => [email, _id]));
			const values = [];
			for (const entry of page) {
				const email = String(entry.subscriber_email ?? "").toLowerCase();
				const contactId = idByEmail.get(email);
				if (!contactId) {
					missing++;
					continue;
				}
				values.push({
					...mapActivity(entry, { campaignId: row._id, newsletterId: row.newsletterId, contactId, sentAt, bounced: bounced.has(email) }),
					provider: mailboxProvider(email),
				});
			}
			if (values.length > 0) await db.insert(messages).values(values).onConflictDoNothing();
			count("messages", values.length);
			page = [];
		}
		for await (const entry of activity(campaign)) {
			page.push(entry);
			if (page.length >= BATCH) await flush();
		}
		await flush();
		if (missing) count("activity rows without a contact in the newsletter (left the group, Spell...)", missing);
		log(`activity for "${row.subject}" done`);
	}

}

// Engagement per contact from the imported history, so most-engaged-first sends and the list cleanup
// work from the first send. ignored_issues counts issues since the last open or click.
async function stageEngagement() {
	if (isDryRun) return;
	const ids = Object.values(await getNewsletterIds());
	// Fresh statistics first: right after a bulk insert the planner would guess tiny tables and pick
	// nested loops over hundreds of thousands of rows.
	await query(sql`analyze messages`);
	await query(sql`analyze contacts`);
	await query(sql`
		with per_contact as (
			select contact_id, max(sent_at) as last_sent, max(opened_at) as last_open, max(clicked_at) as last_click,
				count(*)::int as sent, count(opened_at)::int as opens, count(clicked_at)::int as clicks
			from messages
			where kind = 'campaign' and contact_id is not null and newsletter_id in ${ids}
			group by contact_id
		),
		ignored as (
			select m.contact_id, count(*)::int as ignored
			from messages m join per_contact p on p.contact_id = m.contact_id
			where m.kind = 'campaign' and m.sent_at > coalesce(greatest(p.last_open, p.last_click), '-infinity'::timestamptz)
			group by m.contact_id
		)
		update contacts c set
			last_sent_at = p.last_sent,
			last_open_at = greatest(c.last_open_at, p.last_open),
			last_click_at = greatest(c.last_click_at, p.last_click),
			last_engaged_at = greatest(c.last_engaged_at, p.last_open, p.last_click),
			stats = jsonb_build_object('sent', p.sent, 'opens', p.opens, 'clicks', p.clicks),
			ignored_issues = coalesce(i.ignored, 0)
		from per_contact p left join ignored i on i.contact_id = p.contact_id
		where c.id = p.contact_id`);
	log("contact engagement recalculated");
}

async function stageAutomations() {
	const ids = isDryRun ? {} : await getNewsletterIds();
	const existing = isDryRun
		? new Set()
		: new Set((await getDb().select({ externalId: automations.externalId }).from(automations).where(eq(automations.externalSource, SOURCE))).map(({ externalId }) => externalId));
	const list = [];
	for await (const automation of ml.pages("automations")) list.push(automation);
	for (const summary of list) {
		const automation = (await ml.get(`automations/${summary.id}`)).data;
		const mapped = mapAutomation(automation, { groupSlugs: GROUPS });
		if (!mapped.slug) {
			note("automations skipped (other groups)", automation.name);
			continue;
		}
		for (const problem of mapped.problems) note("automation problems", `${automation.name}: ${problem}`);
		// Already here: it keeps its status and edits, and only gets MailerLite's numbers.
		if (existing.has(mapped.values.externalId)) {
			count(`automations updated in ${mapped.slug}`);
			await getDb().update(automations).set({ stats: mapped.values.stats }).where(and(eq(automations.externalSource, SOURCE), eq(automations.externalId, mapped.values.externalId)));
			continue;
		}
		for (const { nodeId, previewUrl } of mapped.emails) {
			const html = await emailHtml(previewUrl, `${automation.name} / ${nodeId}`);
			const node = mapped.values.nodes[nodeId];
			node.html = html;
			// A Markdown version to start from in the editor: the imported HTML stays what's sent until then.
			node.markdownDraft = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
		}
		count(`automations in ${mapped.slug}`);
		log(`automation "${automation.name}": ${Object.keys(mapped.values.nodes).length} steps, ${mapped.values.stats.imported.queued} still queued in MailerLite`);
		if (isDryRun) continue;
		const { externalId, ...values } = mapped.values;
		// Imported as drafts.
		await getDb()
			.insert(automations)
			.values({ ...values, newsletterId: ids[mapped.slug], externalSource: SOURCE, externalId })
			.onConflictDoNothing();
	}
}

const RUN = {
	newsletters: stageNewsletters,
	attribution: stageAttribution,
	contacts: stageContacts,
	campaigns: stageCampaigns,
	content: stageContent,
	activity: stageActivity,
	engagement: stageEngagement,
	automations: stageAutomations,
};

try {
	for (const stage of STAGES.filter((name) => stages.includes(name))) {
		log(`── ${stage}${isDryRun ? " (dry run)" : ""}`);
		await RUN[stage]();
	}
	report.requests = ml.stats().requests;
	const notes = Object.fromEntries(
		Object.entries(report.notes).map(([key, values]) => [key, values.length > 25 ? [...values.slice(0, 25), `…and ${values.length - 25} more`] : values])
	);
	console.log(JSON.stringify({ ...report, notes }, null, 2));
} finally {
	if (!isDryRun) await getDb().$client?.end?.({ timeout: 5 });
}
