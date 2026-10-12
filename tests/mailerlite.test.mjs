import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cleanMailerLiteHtml, decodeCloudflareEmail, listImages, replaceUrls } from "../lib/mailerlite/html.js";
import { campaignNewsletter, campaignTarget, mapActivity, mapAutomation, mapCampaign, mapSubscriber, orderSteps, toDate, toProperties } from "../lib/mailerlite/map.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/mailerlite/${name}`, import.meta.url), "utf8");
const GROUPS = { "142494481993696777": "supadata", "177927987388221151": "poof", "128577143579871085": "gistly" };

function subscriber(status, groups, extra = {}) {
	return {
		id: "1001",
		email: "Reader@Example.com",
		status,
		subscribed_at: "2025-01-22 01:16:30",
		unsubscribed_at: status === "unsubscribed" ? "2026-10-09 02:00:18" : null,
		opted_in_at: null,
		sent: 26,
		open_rate: 50,
		click_rate: 3.85,
		fields: { name: "Dana", last_name: null, z_i_p: "00-001", company: "" },
		groups: groups.map((name) => ({ id: Object.keys(GROUPS).find((id) => GROUPS[id] === name) ?? "999", name })),
		...extra,
	};
}

const statuses = (result) => Object.fromEntries(result.contacts.map(({ slug, values }) => [slug, values.status]));

test("dates are UTC and fields become properties", () => {
	assert.equal(toDate("2025-01-22 01:16:30").toISOString(), "2025-01-22T01:16:30.000Z");
	assert.equal(toDate(null), null);
	assert.deepEqual(toProperties({ name: "Dana", last_name: null, z_i_p: "00-001", company: "" }), { name: "Dana", zip: "00-001" });
});

test("an active subscriber becomes a contact in each product group, with the old engagement", () => {
	const result = mapSubscriber(subscriber("active", ["supadata", "gistly", "spell"]), { groupSlugs: GROUPS });
	assert.deepEqual(statuses(result), { supadata: "active", gistly: "active" });
	const { values } = result.contacts[0];
	assert.equal(values.email, "reader@example.com");
	assert.equal(values.source, "mailerlite");
	assert.deepEqual(values.imported, { emailsReceived: 26, openRate: 0.5, clickRate: 0.0385 });
	assert.deepEqual(values.properties, { name: "Dana", zip: "00-001" });
	assert.equal(result.suppression, null);
});

test("unsubscribes stay in the product they came from", () => {
	const one = mapSubscriber(subscriber("unsubscribed", ["poof"]), { groupSlugs: GROUPS });
	assert.deepEqual(statuses(one), { poof: "unsubscribed" });
	assert.equal(one.contacts[0].values.unsubscribedAt.toISOString(), "2026-10-09T02:00:18.000Z");

	const traced = mapSubscriber(subscriber("unsubscribed", ["supadata", "gistly"]), { groupSlugs: GROUPS, attribution: new Set(["supadata"]) });
	assert.deepEqual(statuses(traced), { supadata: "unsubscribed", gistly: "active" });

	const untraced = mapSubscriber(subscriber("unsubscribed", ["supadata", "gistly"]), { groupSlugs: GROUPS });
	assert.deepEqual(statuses(untraced), { supadata: "unsubscribed", gistly: "unsubscribed" }, "unknown: all of their products");
	assert.equal(untraced.note, "unattributed");

	const groupless = mapSubscriber(subscriber("unsubscribed", []), { groupSlugs: GROUPS, attribution: new Set(["gistly"]) });
	assert.deepEqual(statuses(groupless), { gistly: "unsubscribed" }, "kept where a campaign shows they left");
	assert.deepEqual(mapSubscriber(subscriber("unsubscribed", ["spell"]), { groupSlugs: GROUPS }).contacts, []);
});

test("only a hard bounce suppresses everywhere; spam reports stay per product", () => {
	const bounced = mapSubscriber(subscriber("bounced", ["supadata", "poof"]), { groupSlugs: GROUPS });
	assert.deepEqual(statuses(bounced), { supadata: "bounced", poof: "bounced" });
	assert.deepEqual(bounced.suppression, { email: "reader@example.com", reason: "bounce", detail: "mailerlite" });
	const groupless = mapSubscriber(subscriber("bounced", []), { groupSlugs: GROUPS });
	assert.deepEqual(groupless.contacts, []);
	assert.ok(groupless.suppression, "a dead address is suppressed even without a group");

	const junk = mapSubscriber(subscriber("junk", ["supadata"]), { groupSlugs: GROUPS });
	assert.deepEqual(statuses(junk), { supadata: "complained" });
	assert.equal(junk.suppression, null);
	assert.deepEqual(statuses(mapSubscriber(subscriber("unconfirmed", ["poof"]), { groupSlugs: GROUPS })), { poof: "pending" });
});

test("campaigns map to the newsletter of the group they went to, not their name", () => {
	const campaigns = JSON.parse(fixture("campaigns.json"));
	const byName = Object.fromEntries(campaigns.map((campaign) => [campaign.name, campaign]));
	assert.equal(campaignNewsletter(byName["[Supadata] Rewards & team"], GROUPS), "supadata");
	assert.equal(campaignNewsletter(byName["Supadata cross-promo"], GROUPS), "gistly");
	assert.equal(campaignNewsletter(byName.Reactivation, GROUPS), null);
	assert.deepEqual(campaignTarget(byName.Reactivation, GROUPS), { slug: null, bySegment: true }, "a segment: decided from its recipients");
	assert.deepEqual(campaignTarget({ filter: [[{ operator: "in_all", args: ["groups", ["555"]] }]] }, GROUPS), { skip: true }, "another group (Spell)");
	assert.deepEqual(campaignTarget({ filter: [] }, GROUPS), { skip: true }, "everyone");

	const mapped = mapCampaign(byName["[Supadata] Rewards & team"]);
	assert.equal(mapped.status, "sent");
	assert.equal(mapped.format, "html");
	assert.equal(mapped.subject, "Earn free credits with Supadata 🎁");
	assert.equal(mapped.sentAt.toISOString(), "2026-10-08T17:40:46.000Z");
	assert.equal(mapped.stats.sent, 70361);
	assert.equal(mapped.stats.bounced, 90);
	assert.match(mapped.previewUrl, /^https:\/\/preview\.mailerlite\.io\//);
});

test("activity rows become delivered or bounced messages with opens and clicks at the send time", () => {
	const sentAt = new Date("2026-10-08T17:40:46Z");
	const context = { campaignId: "c", newsletterId: "n", contactId: "k", sentAt };
	const clicked = mapActivity({ subscriber_email: "A@x.com", opens_count: 0, clicks_count: 2 }, { ...context, bounced: false });
	assert.equal(clicked.email, "a@x.com");
	assert.equal(clicked.openedAt, sentAt, "a click is an open");
	assert.equal(clicked.clickedAt, sentAt);
	const bounced = mapActivity({ subscriber_email: "b@x.com", opens_count: 1, clicks_count: 0 }, { ...context, bounced: true });
	assert.equal(bounced.status, "bounced");
	assert.equal(bounced.deliveredAt, null);
	assert.equal(bounced.openedAt, null);
});

test("the Poof nurture becomes send and wait nodes in the order MailerLite runs them", () => {
	const automation = JSON.parse(fixture("automation.json"));
	const mapped = mapAutomation(automation, { groupSlugs: GROUPS });
	assert.equal(mapped.slug, "poof");
	assert.deepEqual(mapped.problems, []);
	assert.equal(mapped.values.status, "draft");
	assert.equal(mapped.values.startNodeId, "email-1");
	assert.deepEqual(mapped.values.nodes, {
		"email-1": { type: "send", subject: "Welcome to Poof", previewText: "", html: "", next: "wait-1" },
		"wait-1": { type: "wait", duration: "4d", next: "email-2" },
		"email-2": { type: "send", subject: "Need a hand?", previewText: "", html: "" },
	});
	assert.equal(mapped.emails.length, 2);
	assert.ok(mapped.emails.every(({ previewUrl }) => previewUrl?.startsWith("https://")));
	assert.equal(mapped.values.stats.imported.queued, automation.stats.subscribers_in_queue_count);
});

test("forks in a MailerLite automation are reported, not guessed", () => {
	const steps = [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 1 }];
	assert.match(orderSteps(steps).problem, /2 next steps/);
});

test("MailerLite's own links and Cloudflare's email scrambling come out of the HTML", () => {
	assert.equal(decodeCloudflareEmail("2c5f595c5c435e586c5f595c4d484d584d024d45"), "support@supadata.ai");
	const original = fixture("email.html");
	const { html, imageUrls } = cleanMailerLiteHtml(original);
	assert.ok(!/data-link-type="(webview|unsubscribe)"/.test(html));
	assert.ok(!html.includes("View in browser"));
	assert.ok(!/unsubscribe/i.test(html), "Mailcheap's footer brings the unsubscribe link");
	assert.ok(!html.includes("You received this email because"));
	assert.ok(!html.includes("cdn-cgi"));
	assert.ok(html.includes('href="mailto:support@supadata.ai"'));
	assert.ok(html.includes('href="https://dash.supadata.ai/organizations/rewards"'), "content links stay");
	assert.equal(imageUrls.length, 3);
	assert.ok(imageUrls.every((url) => url.startsWith("https://storage.mlcdn.com/")));
	const moved = replaceUrls(html, { [imageUrls[0]]: "https://x.supabase.co/storage/v1/object/public/uploads/a.png" });
	assert.equal(listImages(moved).length, 2);
});

test("merge tags take their default", () => {
	assert.equal(cleanMailerLiteHtml("<p>Hi {$name|default('there')}, {$company}!</p>").html, "<p>Hi there, !</p>");
});

test("MailerLite's font stylesheet isn't imported from MailerLite any more", () => {
	const html = `<style type="text/css">@import url("https://assets.mlcdn.com/fonts-v2.css?version=1758718");</style><p>Hi</p>`;
	assert.equal(cleanMailerLiteHtml(html).html, `<style type="text/css"></style><p>Hi</p>`);
});
