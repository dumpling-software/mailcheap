import TurndownService from "turndown";

// Turns an HTML email (an imported MailerLite campaign) into Markdown for the editor. Layout tables
// fall away, buttons become [[label]](url) and pictures stay. Server-only: turndown brings its own DOM.
const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", emDelimiter: "*" });
turndown.remove(["style", "head", "title", "meta", "script"]);
// Spacer cells and the empty paragraphs and quotes MailerLite puts between blocks.
turndown.addRule("emptyParagraph", {
	filter: (node) => ["P", "BLOCKQUOTE"].includes(node.nodeName) && !node.textContent.trim() && !node.querySelector("img"),
	replacement: () => "\n\n",
});
// Small print, like the caption MailerLite puts under a video thumbnail. Marked here and made the
// picture's caption ("title") if it follows one; anywhere else it stays a paragraph.
const SMALL_FONT_PX = 14;
let smallTexts = [];
turndown.addRule("smallText", {
	filter: (node) => {
		if (node.nodeName !== "P" || !node.textContent.trim() || node.querySelector("img")) return false;
		const size = /font-size:\s*(\d+(?:\.\d+)?)px/i.exec(node.getAttribute("style") ?? "");
		return Boolean(size) && Number(size[1]) <= SMALL_FONT_PX;
	},
	replacement: (content, node) => {
		smallTexts.push({ markdown: content.trim(), text: node.textContent.replace(/\s+/g, " ").trim() });
		return `\n\n\u0000small:${smallTexts.length - 1}\u0000\n\n`;
	},
});
const SMALL_TEXT_MARK = /\u0000small:(\d+)\u0000/g;
const PICTURE_LINE = /^(\[?!\[[^\]\n]*\]\((\S+?))\)(\]\([^)\s]+\))?$/;

function placeSmallTexts(markdown, texts) {
	const blocks = markdown.split(/\n{2,}/);
	for (let index = 0; index < blocks.length; index++) {
		const mark = /^\u0000small:(\d+)\u0000$/.exec(blocks[index].trim());
		if (!mark) continue;
		const { text } = texts[Number(mark[1])];
		const picture = index > 0 ? PICTURE_LINE.exec(blocks[index - 1].trim()) : null;
		if (picture && !/"/.test(text)) {
			blocks[index - 1] = `${picture[1]} "${text}")${picture[3] ?? ""}`;
			blocks[index] = "";
		}
	}
	return blocks
		.filter((block) => block !== "")
		.join("\n\n")
		.replace(SMALL_TEXT_MARK, (_mark, index) => texts[Number(index)].markdown);
}

// MailerLite draws a button as a link with padding, often display:block, in a table cell.
turndown.addRule("button", {
	filter: (node) =>
		node.nodeName === "A" &&
		/padding\s*:/i.test(node.getAttribute("style") ?? "") &&
		/^(https?:|mailto:)/i.test(node.getAttribute("href") ?? "") &&
		Boolean(node.textContent.trim()),
	replacement: (_content, node) =>
		`\n\n[[${node.textContent.trim().replace(/\s+/g, " ")}]](${node.getAttribute("href")})${isCentered(node) ? "{.center}" : ""}\n\n`,
});
turndown.addRule("image", {
	filter: "img",
	replacement: (_content, node) => {
		const src = node.getAttribute("src") ?? "";
		if (!/^https?:/i.test(src)) return "";
		// Tracking pixels and spacers.
		const width = Number(node.getAttribute("width"));
		if (width > 0 && width < 10) return "";
		const alt = (node.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
		// Inside a link (a video thumbnail) blank lines would break the [![](img)](url) around it.
		return isInLink(node) ? `![${alt}](${src})` : `\n\n![${alt}](${src})\n\n`;
	},
});

// The table holding a button places it (MailerLite's ml-btn-container); cells inside it only center
// the label.
function isCentered(node) {
	for (let parent = node.parentNode; parent?.getAttribute; parent = parent.parentNode) {
		if (parent.nodeName !== "TABLE") continue;
		const align = parent.getAttribute("align") || /text-align:\s*(\w+)/i.exec(parent.getAttribute("style") ?? "")?.[1];
		if (align) return align.toLowerCase() === "center";
	}
	return false;
}

function isInLink(node) {
	for (let parent = node.parentNode; parent; parent = parent.parentNode) {
		if (parent.nodeName === "A") return true;
	}
	return false;
}

// The signature and founder card the product's template adds again: from a "- Rafal from Poof -"
// line to the end.
const SIGNATURE_LINE = /^\s*\\?-\s+[^\n]{1,40}\s+from\s+[^\n]{1,40}\s+-\s*$/im;

function bodyOf(html) {
	const start = html.search(/<body[^>]*>/i);
	const end = html.search(/<\/body>/i);
	const body = start === -1 ? html : html.slice(html.indexOf(">", start) + 1, end === -1 ? undefined : end);
	return body
		// Outlook-only parts; <!--[if !mso]><!--> parts are for everyone else and stay.
		.replace(/<!--\[if [^\]]*\]>(?!<!--|-->)[\s\S]*?<!\[endif\]-->/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		// Preheader text at the top: hidden, or padded with invisible characters so the inbox preview
		// shows nothing after it.
		.replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
		.replace(/<td\b[^>]*>(?:(?!<\/?td\b)[\s\S])*?(?:[\u034f\u00ad]|&#847;|&shy;|&#173;)(?:(?!<\/?td\b)[\s\S])*<\/td>/gi, "<td></td>");
}

function normalize(text) {
	return text.replace(/[*_\\]/g, "").replace(/\s+/g, " ").trim();
}

// dropSignature: the product's template adds the signature again. previewText: MailerLite also
// prints it at the top of the email, where it would become the first paragraph.
export function htmlEmailToMarkdown(html, { dropSignature = false, previewText = "" } = {}) {
	smallTexts = [];
	let markdown = placeSmallTexts(turndown.turndown(bodyOf(String(html ?? ""))), smallTexts);
	if (dropSignature) {
		const signature = SIGNATURE_LINE.exec(markdown);
		if (signature) markdown = markdown.slice(0, signature.index);
	}
	if (previewText.trim()) {
		const paragraphs = markdown.split(/\n{2,}/);
		const index = paragraphs.slice(0, 3).findIndex((paragraph) => normalize(paragraph) === normalize(previewText));
		if (index !== -1) paragraphs.splice(index, 1);
		markdown = paragraphs.join("\n\n");
	}
	return markdown
		.replace(/^[ \t\u00a0]+$/gm, "")
		.replace(/[ \t]+$/gm, "")
		// Bold split into adjacent tags (<strong>e</strong><strong>nter</strong>) would leave "**e****nter**".
		.replace(/(\S)\*{4}(?=\S)/g, "$1")
		// Empty headings (MailerLite's blank title blocks) would render as nothing or a stray "#####".
		.replace(/^#{1,6}$/gm, "")
		.replace(/^(\s*\*\s*\*\s*\*\s*|\s*-{3,}\s*)$/gm, "---")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/(\n*---\s*)+$/, "")
		.trim();
}
