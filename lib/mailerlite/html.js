// Turns an email from MailerLite's preview page into HTML Mailcheap can send: its own unsubscribe and
// "View in browser" links go (Mailcheap adds its footer with the unsubscribe link and postal address),
// Cloudflare's email obfuscation from the preview page is undone, and merge tags become their default.
// Pure: the importer re-hosts the images it lists (scripts/mailerlite).

const SPECIAL_LINK = /<a\b[^>]*\bdata-link-type="(?:webview|unsubscribe|forward|preferences)"[^>]*>[\s\S]*?<\/a>/gi;
const RECEIVED_BECAUSE = /<p\b[^>]*>\s*You received this email because[\s\S]*?<\/p>/gi;
const SCRIPT = /<script\b[\s\S]*?<\/script>/gi;
const BUILDER_ATTRIBUTES = /\s(?:data-link-id|builder-link-id|data-link-type)="[^"]*"/gi;
const CF_EMAIL_LINK = /href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi;
const CF_EMAIL_SPAN = /<(span|a)\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/\1>/gi;
// {$name}, {$name|default('there')} and MailerLite's other variables.
const MERGE_TAG = /\{\$([a-z_]+)(?:\|default\((['"])(.*?)\2\))?\}/gi;
const IMAGE_SOURCE = /\b(?:src|background)="(https:\/\/[^"]*?(?:mlcdn\.com|mailerlite\.com|mlsend\.com)\/[^"]+)"/gi;
const TRACKING_PIXEL = /<img\b[^>]*\bsrc="https:\/\/[^"]*(?:mlsend\.com|mailerlite\.com)\/[^"]*(?:open|track)[^"]*"[^>]*>/gi;

// Cloudflare's scheme: the first byte is a key XORed into every following byte.
export function decodeCloudflareEmail(hex) {
	const key = Number.parseInt(hex.slice(0, 2), 16);
	let email = "";
	for (let index = 2; index < hex.length; index += 2) {
		email += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16) ^ key);
	}
	return email;
}

function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function cleanMailerLiteHtml(html) {
	const cleaned = String(html ?? "")
		.replace(SCRIPT, "")
		.replace(CF_EMAIL_LINK, (_, hex) => `href="mailto:${escapeHtml(decodeCloudflareEmail(hex))}"`)
		.replace(CF_EMAIL_SPAN, (_, _tag, hex) => escapeHtml(decodeCloudflareEmail(hex)))
		.replace(SPECIAL_LINK, "")
		.replace(RECEIVED_BECAUSE, "")
		.replace(TRACKING_PIXEL, "")
		.replace(BUILDER_ATTRIBUTES, "")
		.replace(MERGE_TAG, (_, _name, _quote, fallback) => escapeHtml(fallback ?? ""));
	return { html: cleaned, imageUrls: listImages(cleaned) };
}

// MailerLite-hosted images, which stop loading once the account closes.
export function listImages(html) {
	return [...new Set([...String(html).matchAll(IMAGE_SOURCE)].map((match) => match[1]))];
}

export function replaceUrls(html, replacements) {
	let result = html;
	for (const [from, to] of Object.entries(replacements)) result = result.replaceAll(from, to);
	return result;
}
