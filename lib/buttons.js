// A call-to-action button: a line of its own written as [[Try it now]](https://example.com).
// Email clients only draw a reliable button from a table cell with a link in it; the product's
// template colors it through the .btn-cell and .btn classes.
const BUTTON_PATTERN = /^\[\[([^\]\n]+)\]\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|\{\{[a-z_]+\}\})\)[ \t]*(?:\n+|$)/;
const BUTTON_START_PATTERN = /^\[\[[^\]\n]+\]\]\(/m;
// marked asks where the next button starts before every paragraph and text run, so looking through
// the whole rest of the document each time would be quadratic. A button further into a paragraph than
// this (no blank line before it) stays text, like a button inside a sentence.
const START_LOOKAHEAD = 2000;

const CELL_STYLE = "border-radius:8px;background:#18181b;";
const LINK_STYLE =
	"display:inline-block;padding:12px 24px;border-radius:8px;color:#ffffff;font-weight:600;text-decoration:none;";

function escapeAttribute(value) {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buttonHtml(label, href, { isEmail = false } = {}) {
	if (!isEmail) {
		return `<p><a class="btn" data-button href="${escapeAttribute(href)}">${label}</a></p>\n`;
	}
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td class="btn-cell" style="${CELL_STYLE}"><a class="btn" href="${escapeAttribute(href)}" target="_blank" style="${LINK_STYLE}">${label}</a></td></tr></table>\n`;
}

export function buttonExtension({ isEmail = false } = {}) {
	return {
		extensions: [
			{
				name: "button",
				level: "block",
				start(src) {
					return BUTTON_START_PATTERN.exec(src.slice(0, START_LOOKAHEAD))?.index;
				},
				tokenizer(src) {
					const match = BUTTON_PATTERN.exec(src);
					if (!match) return undefined;
					return { type: "button", raw: match[0], href: match[2], tokens: this.lexer.inlineTokens(match[1].trim()) };
				},
				renderer(token) {
					return buttonHtml(this.parser.parseInline(token.tokens), token.href, { isEmail });
				},
			},
		],
	};
}
