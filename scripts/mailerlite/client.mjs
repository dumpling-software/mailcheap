// MailerLite's API (connect.mailerlite.com), read-only. Every response is cached on disk, so a stopped
// import picks up where it was; --refresh asks MailerLite again (for a final sync). Stays under the
// 120 requests a minute MailerLite allows, and waits out 429s and server errors.
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const API = "https://connect.mailerlite.com/api/";
const MAX_ATTEMPTS = 6;

export function createClient({ apiKey, cacheDir, refresh = false, requestsPerMinute = 110, log = console.log }) {
	if (!apiKey) throw new Error("MAILERLITE_API_KEY is not set");
	mkdirSync(cacheDir, { recursive: true });
	const interval = Math.ceil(60_000 / requestsPerMinute);
	let nextAt = 0;
	let requests = 0;

	async function throttle() {
		const wait = nextAt - Date.now();
		nextAt = Math.max(Date.now(), nextAt) + interval;
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}

	function cachePath(key, extension) {
		const readable = key.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
		const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
		return path.join(cacheDir, `${readable}-${hash}.${extension}`);
	}

	async function request(url, { json, headers = {} }) {
		for (let attempt = 1; ; attempt++) {
			await throttle();
			requests++;
			const response = await fetch(url, { headers: { Accept: json ? "application/json" : "*/*", ...headers } });
			if (response.ok) return json ? response.json() : Buffer.from(await response.arrayBuffer());
			const retryable = response.status === 429 || response.status >= 500;
			if (!retryable || attempt >= MAX_ATTEMPTS) {
				throw new Error(`${response.status} from ${url.replace(API, "")}: ${(await response.text()).slice(0, 300)}`);
			}
			const retryAfter = Number(response.headers.get("retry-after")) * 1000 || 2 ** attempt * 1000;
			log(`  ${response.status}, retrying in ${Math.round(retryAfter / 1000)}s`);
			await new Promise((resolve) => setTimeout(resolve, retryAfter));
		}
	}

	async function cached(key, extension, load) {
		const file = cachePath(key, extension);
		if (!refresh && existsSync(file)) {
			const content = readFileSync(file);
			return extension === "json" ? JSON.parse(content) : content;
		}
		const value = await load();
		writeFileSync(file, extension === "json" ? JSON.stringify(value) : value);
		return value;
	}

	// One API path, like "groups?limit=100".
	function get(apiPath) {
		return cached(apiPath, "json", () => request(`${API}${apiPath}`, { json: true, headers: { Authorization: `Bearer ${apiKey}` } }));
	}

	// Page-numbered lists (campaigns, reports): every page, in order.
	async function* pages(apiPath, { limit = 100 } = {}) {
		const separator = apiPath.includes("?") ? "&" : "?";
		for (let page = 1; ; page++) {
			const body = await get(`${apiPath}${separator}limit=${limit}&page=${page}`);
			for (const row of body.data ?? []) yield row;
			const last = body.meta?.last_page ?? (body.links?.next ? page + 1 : page);
			if (page >= last || (body.data ?? []).length === 0) return;
		}
	}

	// Cursor lists (subscribers).
	async function* cursor(apiPath, { limit = 1000 } = {}) {
		const separator = apiPath.includes("?") ? "&" : "?";
		let next = null;
		do {
			const body = await get(`${apiPath}${separator}limit=${limit}${next ? `&cursor=${next}` : ""}`);
			for (const row of body.data ?? []) yield row;
			next = body.meta?.next_cursor ?? null;
		} while (next);
	}

	// A public URL (preview pages, images), cached like the API.
	function download(url) {
		return cached(url, "bin", () => request(url, { json: false }));
	}

	return { get, pages, cursor, download, stats: () => ({ requests }) };
}
