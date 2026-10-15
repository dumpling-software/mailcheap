"use server";

import { and, desc, eq } from "drizzle-orm";
import { buildMessages, MAX_BRIEF_CHARS, MAX_IMAGES, requestDraft } from "@/lib/ai-draft";
import { requireSession } from "@/lib/auth";
import { isAiConfigured } from "@/lib/config";
import { campaigns, getDb } from "@/lib/db";
import { hasTemplate } from "@/lib/email-template";
import { htmlEmailToMarkdown } from "@/lib/html-to-markdown";
import { isRateLimited } from "@/lib/rate-limit";
import { findCampaign, findNewsletter } from "@/lib/records";
import { MAX_BODY_BYTES } from "@/lib/validation";

// Each draft costs a few cents; this only stops a runaway loop.
const PER_INSTALL = { name: "ai-draft", limit: 60, window: "1 h" };
const IMAGE_URL_PATTERN = /^https:\/\/[^\s"'<>()]{4,800}$/;

// The product's last sent campaigns, as Markdown, show the model its structure and voice.
async function findExamples(newsletter) {
	const rows = await getDb()
		.select({
			subject: campaigns.subject,
			previewText: campaigns.previewText,
			format: campaigns.format,
			markdown: campaigns.markdown,
			html: campaigns.html,
		})
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletter._id), eq(campaigns.status, "sent")))
		.orderBy(desc(campaigns.sentAt))
		.limit(2);
	return rows.map((row) => ({
		subject: row.subject,
		markdown:
			row.format === "markdown"
				? row.markdown
				: htmlEmailToMarkdown(row.html, { dropSignature: hasTemplate(newsletter), previewText: row.previewText }),
	}));
}

// { draft: { subject, previewText, markdown } } or { error }. The editor applies the draft, so it can
// be undone there.
export async function draftWithAi(id, { brief = "", imageUrls = [], mode = "create", draft = null } = {}) {
	await requireSession();
	if (!isAiConfigured()) return { error: "AI drafts need OPENROUTER_API_KEY" };
	const text = String(brief).trim();
	if (!text) return { error: mode === "refine" ? "Say what to change" : "Paste the copy first" };
	if (text.length > MAX_BRIEF_CHARS) return { error: `Keep the copy under ${MAX_BRIEF_CHARS / 1000}k characters` };
	const images = (Array.isArray(imageUrls) ? imageUrls : []).map(String).filter((url) => IMAGE_URL_PATTERN.test(url));
	if (images.length > MAX_IMAGES) return { error: `Use up to ${MAX_IMAGES} pictures` };

	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	const newsletter = await findNewsletter(campaign.newsletterId);
	if (!newsletter) return { error: "Newsletter not found" };
	if (await isRateLimited({ ...PER_INSTALL, key: "install" })) return { error: "Too many AI drafts this hour, try later" };

	const current =
		mode === "refine" && draft
			? {
					subject: String(draft.subject ?? ""),
					previewText: String(draft.previewText ?? ""),
					markdown: String(draft.markdown ?? "").slice(0, MAX_BODY_BYTES),
				}
			: null;
	try {
		const examples = await findExamples(newsletter);
		const result = await requestDraft(
			buildMessages({ newsletter, examples, brief: text, imageUrls: images, mode: current ? "refine" : "create", draft: current })
		);
		if (Buffer.byteLength(result.markdown, "utf8") > MAX_BODY_BYTES) return { error: "The AI draft is too long" };
		return { draft: result };
	} catch (error) {
		console.error("[ai-draft]", error);
		return { error: error.name === "TimeoutError" ? "The AI took too long, try again" : error.message };
	}
}
