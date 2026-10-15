import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { applyTemplate, inlineTemplateStyles, parseInlineRules, validateTemplate } from "../lib/email-template.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "../lib/render-email.js";

const layout = `<!DOCTYPE html><html><head><title>{{subject}}</title></head><body><main>{{content}}</main><footer>{{footer}}</footer></body></html>`;
const css = `.body h2 { color: #000; font-size: 24px }
.body a, .body p { color: #363636 }
.btn-cell { background: #6466F1 }
.btn { color: #ffffff; text-decoration: none }
@media (max-width: 600px) { .body h2 { font-size: 20px } }
.body h1:first-child { margin-top: 0 }`;

test("templates need one content and one footer slot, no scripts, and a size limit", () => {
	assert.equal(validateTemplate({ layout: "", css: "" }), null);
	assert.equal(validateTemplate({ layout, css }), null);
	assert.match(validateTemplate({ layout: "<p>{{footer}}</p>" }), /\{\{content\}\}/);
	assert.match(validateTemplate({ layout: "{{content}}{{content}}{{footer}}" }), /exactly once/);
	assert.match(validateTemplate({ layout: "{{content}}" }), /\{\{footer\}\}/);
	assert.match(validateTemplate({ layout: `${layout}<script>x</script>` }), /scripts/);
	assert.match(validateTemplate({ layout, css: "</style><img>" }), /style/);
	assert.match(validateTemplate({ layout: layout + "x".repeat(31_000) }), /under 30 KB/);
});

test("only plain .body tag and class rules are inlined, not media queries or pseudo selectors", () => {
	const rules = parseInlineRules(css);
	assert.deepEqual(
		rules.map(({ selectors }) => selectors),
		[[{ tag: "h2" }], [{ tag: "a" }, { tag: "p" }], [{ className: "btn-cell" }], [{ className: "btn" }]]
	);
	assert.equal(rules[0].style, "color: #000;font-size: 24px");
});

test("inlined rules come after existing styles, and buttons skip the rules for every link", () => {
	const html = inlineTemplateStyles(
		'<h2>Hi</h2><p style="margin:0">Text <a href="#">link</a></p><td class="btn-cell" style="background:#000"><a class="btn" href="#">Go</a></td>',
		css
	);
	assert.ok(html.includes('<h2 style="color: #000;font-size: 24px">'));
	assert.ok(html.includes('<p style="margin:0;color: #363636">'));
	assert.ok(html.includes('<a style="color: #363636" href="#">link</a>'));
	assert.ok(html.includes('class="btn-cell" style="background:#000;background: #6466F1"'));
	assert.ok(html.includes('<a style="color: #ffffff;text-decoration: none" class="btn" href="#">Go</a>'));
});

test("applyTemplate fills the slots and keeps $ in the content as written", () => {
	const html = applyTemplate({ layout, css }, { content: "Price: $& $1", footer: "<p>Bye</p>", top: "<i>top</i>" });
	assert.ok(html.includes("<main>Price: $& $1</main>"));
	assert.ok(html.includes("<footer><p>Bye</p></footer>"));
	assert.ok(html.includes("<body><i>top</i>"));
	assert.ok(html.indexOf("<style>") < html.indexOf("</head>"));
});

test("a product with a template renders Markdown into it, with the footer and preheader", () => {
	const newsletter = { name: "Poof", postalAddress: "Kollwitzstrasse 76, 10435 Berlin", template: { layout, css } };
	const { html, text } = renderEmail({
		markdown: "## Studio\n\n[[Try it now]](https://dash.poof.bg)",
		subject: "News & more",
		previewText: "Fresh",
		newsletter,
	});
	assert.ok(html.includes("<title>News &amp; more</title>"));
	assert.ok(html.includes('<h2 style="color: #000;font-size: 24px">Studio</h2>'));
	assert.match(html, /<td class="btn-cell" style="[^"]*background: #6466F1">/);
	assert.ok(html.includes(UNSUBSCRIBE_PLACEHOLDER));
	assert.ok(html.includes("Kollwitzstrasse 76"));
	assert.match(html, /<body><div style="display:none[^>]*data-preheader>Fresh/);
	assert.ok(text.includes("Try it now (https://dash.poof.bg)"));
});

test("a product without a template keeps the built-in design", () => {
	const { html } = renderEmail({ markdown: "Hi", newsletter: { name: "Gistly", template: null } });
	assert.ok(html.includes("max-width:600px"));
});

test("the shipped product templates are valid and keep emails small", () => {
	for (const slug of ["poof", "supadata", "gistly"]) {
		const template = {
			layout: fs.readFileSync(new URL(`../templates/${slug}.html`, import.meta.url), "utf8"),
			css: fs.readFileSync(new URL(`../templates/${slug}.css`, import.meta.url), "utf8"),
		};
		assert.equal(validateTemplate(template), null, slug);
		const { bytes } = renderEmail({ markdown: "# Hi\n\nText", newsletter: { name: slug, template } });
		assert.ok(bytes < 20_000, `${slug} is ${bytes} bytes`);
	}
});
