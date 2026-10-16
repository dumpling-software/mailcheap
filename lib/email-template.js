// A product's own email design for Markdown and editor campaigns, automations and welcome emails.
// `layout` is a whole HTML document with {{content}} and {{footer}} slots; `css` styles the written
// part. Clients that drop <style> (some Gmail apps) still get the main rules: they are copied inline.
export const CONTENT_SLOT = "{{content}}";
export const FOOTER_SLOT = "{{footer}}";
export const MAX_TEMPLATE_BYTES = 30_000;

// Selectors the inliner understands: ".body h2", ".body a, .body p", ".btn", ".btn-cell".
const BODY_TAG_SELECTOR = /^\.body\s+([a-z][a-z0-9]*)$/i;
const CLASS_SELECTOR = /^\.([a-z][a-z0-9-]*)$/i;

export function hasTemplate(newsletter) {
	return Boolean(newsletter?.template?.layout?.includes(CONTENT_SLOT));
}

function countOf(text, part) {
	return text.split(part).length - 1;
}

// A problem to show in the form, or null.
export function validateTemplate({ layout = "", css = "" } = {}) {
	if (!layout.trim() && !css.trim()) return null;
	if (countOf(layout, CONTENT_SLOT) !== 1) return `The layout needs ${CONTENT_SLOT} exactly once`;
	if (countOf(layout, FOOTER_SLOT) !== 1) return `The layout needs ${FOOTER_SLOT} exactly once`;
	if (/<script\b/i.test(layout) || /<script\b/i.test(css)) return "Templates can't contain scripts";
	if (/<\/style/i.test(css)) return "The CSS can't close its <style> tag";
	if (new TextEncoder().encode(layout + css).length > MAX_TEMPLATE_BYTES) {
		return `The template must be under ${MAX_TEMPLATE_BYTES / 1000} KB`;
	}
	return null;
}

// [{ selectors, style }] for the rules the inliner understands; other rules stay in <style> only.
export function parseInlineRules(css = "") {
	const rules = [];
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	// Rules inside @media and other at-blocks only apply in <style>.
	const topLevel = withoutComments.replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
	for (const match of topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const style = match[2]
			.split(";")
			.map((declaration) => declaration.trim())
			.filter((declaration) => /^[a-z-]+\s*:/i.test(declaration) && !/!important/i.test(declaration))
			.join(";");
		if (!style) continue;
		const selectors = match[1]
			.split(",")
			.map((selector) => selector.trim())
			.map((selector) => {
				const tag = BODY_TAG_SELECTOR.exec(selector)?.[1];
				if (tag) return { tag: tag.toLowerCase() };
				const className = CLASS_SELECTOR.exec(selector)?.[1];
				return className ? { className } : null;
			})
			.filter(Boolean);
		if (selectors.length > 0) rules.push({ selectors, style: style.replace(/"/g, "'") });
	}
	return rules;
}

function addStyle(tag, style) {
	const existing = /\sstyle="([^"]*)"/i.exec(tag);
	if (existing) {
		const merged = `${existing[1].replace(/;?\s*$/, "")};${style}`;
		return tag.replace(existing[0], ` style="${merged}"`);
	}
	return tag.replace(/^<([a-z][a-z0-9]*)/i, `<$1 style="${style}"`);
}

// Copies the template's rules onto the written part's tags. Template rules come after what the
// renderer set, so they win. The first element loses its top margin, so an email that opens with a
// heading starts as high as one that opens with text.
export function inlineTemplateStyles(html, css) {
	const rules = parseInlineRules(css);
	if (rules.length === 0) return html;
	return withoutTopMargin(inlineRules(html, rules));
}

function withoutTopMargin(html) {
	return html.replace(/^(\s*)(<[a-z][a-z0-9]*\b[^>]*>)/i, (_, space, tag) => space + addStyle(tag, "margin-top:0"));
}

function inlineRules(html, rules) {
	const styledClasses = new Set(rules.flatMap(({ selectors }) => selectors.map(({ className }) => className)));
	return html.replace(/<([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
		const tagName = name.toLowerCase();
		const classes = (/\sclass="([^"]*)"/i.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
		// A button's link gets the .btn rules, not the ones for every link.
		const hasClassRules = classes.some((className) => styledClasses.has(className));
		let result = tag;
		for (const { selectors, style } of rules) {
			const applies = selectors.some((selector) =>
				selector.className ? classes.includes(selector.className) : !hasClassRules && selector.tag === tagName
			);
			if (applies) result = addStyle(result, style);
		}
		return result;
	});
}

// The template's CSS goes in the <head>, after any <style> the layout has.
export function applyTemplate(template, { content, footer, head = "", top = "" }) {
	const style = template.css?.trim() ? `<style>\n${template.css.trim()}\n</style>` : "";
	let html = template.layout;
	html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${head}${style}</head>`) : `${head}${style}${html}`;
	if (top) html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (match) => `${match}${top}`) : `${top}${html}`;
	// Function replacements, so "$" in the content is kept as written.
	return html.replace(CONTENT_SLOT, () => content).replace(FOOTER_SLOT, () => footer);
}
