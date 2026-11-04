import sanitizeHtml from "sanitize-html";
import { CONTENT_TAGS, KEPT_ATTRIBUTES } from "./clean-html.js";

// The cleaners match tags with patterns; this parses the HTML, so whatever they miss can't run on the
// archive page. Client components import clean-html.js and render-email.js, so the package stays here.
const OPTIONS = {
	allowedTags: CONTENT_TAGS,
	allowedAttributes: {
		...KEPT_ATTRIBUTES,
		img: [
			...KEPT_ATTRIBUTES.img,
			{ name: "loading", values: ["lazy"] },
			{ name: "fetchpriority", values: ["high"] },
			{ name: "decoding", values: ["async"] },
		],
		div: [{ name: "data-callout", values: [""] }],
	},
	allowedEmptyAttributes: ["alt", "data-callout"],
	allowedSchemes: ["http", "https", "mailto"],
	allowProtocolRelative: false,
	exclusiveFilter: isOffWebImage,
};

function isOffWebImage(frame) {
	return frame.tag === "img" && !/^https?:\/\//i.test(frame.attribs.src ?? "");
}

export function sanitizeIssueHtml(html) {
	return sanitizeHtml(html, OPTIONS);
}

// HTML issues keep their own markup and styles in a sandboxed frame. Parsing it, rather than matching
// attributes with a pattern, means a link's URL is the one the browser will follow, so every URL is
// checked: links go to the web, mail or a phone number, pictures also to data: URLs. Nothing in the
// frame runs, but scripts, frames, forms, <base> and refresh redirects go anyway.
const DROPPED_FRAME_TAGS = new Set(["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base"]);
const FRAME_OPTIONS = {
	allowedTags: false,
	allowedAttributes: false,
	allowVulnerableTags: true,
	allowedSchemes: ["http", "https", "mailto", "tel"],
	allowedSchemesByTag: { img: ["http", "https", "data"] },
	allowedSchemesAppliedToAttributes: ["href", "src", "cite", "action", "formaction", "background", "poster", "xlink:href"],
	exclusiveFilter: (frame) =>
		DROPPED_FRAME_TAGS.has(frame.tag) || (frame.tag === "meta" && /refresh/i.test(frame.attribs["http-equiv"] ?? "")),
};

// The parser drops the doctype, without which the frame would lay the email out in quirks mode.
export function sanitizeFramedHtml(html) {
	const doctype = /^\s*(<!doctype\b[^>]*>)/i.exec(html)?.[1] ?? "";
	return doctype + sanitizeHtml(html, FRAME_OPTIONS);
}
