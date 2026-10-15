import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml } from "../lib/markdown.js";
import { renderEmail } from "../lib/render-email.js";

test("a picture's title becomes a caption under it, linked or not", () => {
	const { html } = renderEmail({ markdown: '[![](https://i.example.com/a.jpg "My video")](https://youtu.be/x)\n\n![](https://i.example.com/b.jpg)' });
	assert.match(html, /<p class="figure"[^>]*><a href="https:\/\/youtu.be\/x"><img class="captioned"[^>]*src="https:\/\/i.example.com\/a.jpg"[^>]*><\/a><\/p>\n<p class="caption"[^>]*>My video<\/p>/);
	assert.doesNotMatch(html, /title="My video"/);
	assert.match(html, /<p><img src="https:\/\/i.example.com\/b.jpg" alt=""><\/p>/);
	assert.match(markdownToHtml('![](https://i.example.com/a.jpg "A <b>")'), /<p class="caption">A &lt;b&gt;<\/p>/);
});

test("a picture inside a sentence keeps its title as a tooltip", () => {
	assert.match(markdownToHtml('See ![](https://i.example.com/a.jpg "Tip") here'), /title="Tip"/);
});
