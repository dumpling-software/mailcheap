import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { htmlEmailToMarkdown } from "../lib/html-to-markdown.js";
import { renderEmail } from "../lib/render-email.js";

const poof = fs.readFileSync(new URL("./fixtures/mailerlite/poof-campaign.html", import.meta.url), "utf8");

test("a MailerLite campaign keeps its text, headings, pictures and buttons", () => {
	const markdown = htmlEmailToMarkdown(poof, { dropSignature: true });
	assert.ok(markdown.startsWith("Hi friend,\n\nI thought I'd let you know"));
	assert.match(markdown, /^# Studio app$/m);
	assert.match(markdown, /^# Output options$/m);
	assert.match(markdown, /^!\[\]\(https:\/\/txniotmoskghmzfqvplz\.supabase\.co\/storage\/v1\/object\/public\/uploads\/mailerlite\/Ym95Wks0[^)]+\.png\)$/m);
	assert.match(markdown, /^\[\[Try it now\]\]\(https:\/\/dash\.poof\.bg\/organizations\/studio\)$/m);
	assert.match(markdown, /^\[\[See documentation\]\]\(https:\/\/docs\.poof\.bg\/[^)]+\)$/m);
	assert.match(markdown, /\[shoot me an email\]\(mailto:support@poof\.bg\)/);
	assert.doesNotMatch(markdown, /mso|<!--|<table|v:roundrect/i);
	assert.doesNotMatch(markdown, /\n{3,}/);
});

test("the signature and founder card go when the template adds them, and stay otherwise", () => {
	assert.doesNotMatch(htmlEmailToMarkdown(poof, { dropSignature: true }), /Rafal from Poof|founder of Poof/);
	assert.match(htmlEmailToMarkdown(poof), /Rafal from Poof/);
});

test("MailerLite's visible preheader is dropped when it matches the preview text", () => {
	const html = `<body><table><tr><td align="left">Fresh credits, every month.</td><td style="display:none">${"͏ ".repeat(20)}</td></tr></table><p>Hi friend,</p></body>`;
	assert.equal(htmlEmailToMarkdown(html, { previewText: "Fresh credits, every month." }), "Hi friend,");
	assert.equal(htmlEmailToMarkdown(html), "Fresh credits, every month.\n\nHi friend,");
});

test("tracking pixels and non-web images are left out", () => {
	const html = '<p>Hi</p><img src="https://t.example.com/o.gif" width="1" height="1"><img src="cid:logo">';
	assert.equal(htmlEmailToMarkdown(html), "Hi");
});

test("the converted Poof campaign renders as a small email with real buttons", () => {
	const markdown = htmlEmailToMarkdown(poof, { dropSignature: true });
	const { html, bytes } = renderEmail({ markdown, newsletter: { name: "Poof" } });
	assert.equal((html.match(/class="btn"/g) ?? []).length, 2);
	assert.ok(bytes < 15_000, `${bytes} bytes`);
});
