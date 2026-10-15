import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml } from "../lib/markdown.js";
import { renderEmail } from "../lib/render-email.js";

test("a [[label]](url) line becomes an email button", () => {
	const { html } = renderEmail({ markdown: "Intro\n[[Try **it** now]](https://example.com/a?b=1&c=2)\n\nAfter" });
	assert.match(html, /<td class="btn-cell" style="[^"]+"><a class="btn" href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" style="[^"]+">Try <strong>it<\/strong> now<\/a><\/td>/);
	assert.ok(html.includes("<p>Intro</p>"), "a button ends the paragraph above it");
	assert.ok(html.includes("<p>After</p>"));
});

test("buttons only take web, mailto and placeholder links", () => {
	assert.ok(!markdownToHtml("[[Bad]](javascript:alert(1))").includes("data-button"));
	assert.ok(markdownToHtml("[[Write]](mailto:support@poof.bg)").includes('href="mailto:support@poof.bg"'));
	assert.ok(markdownToHtml("[[Go]]({{unsubscribe_url}})").includes('href="{{unsubscribe_url}}"'));
});

test("outside emails a button is a marked link, so the editor keeps it as a link", () => {
	assert.equal(markdownToHtml("[[Docs]](https://docs.poof.bg)"), '<p><a class="btn" data-button href="https://docs.poof.bg">Docs</a></p>\n');
});

test("a button inside a sentence stays text", () => {
	assert.ok(!markdownToHtml("See [[Docs]](https://docs.poof.bg) here").includes("btn"));
});
