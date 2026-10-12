import "server-only";
import crypto from "node:crypto";
import { StorageClient } from "@supabase/storage-js";

// Sent emails point at these files forever, so their URLs never change and browsers can cache them for a year.
const ONE_YEAR = 365 * 24 * 60 * 60;
let client;

function getSettings() {
	const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, SUPABASE_STORAGE_BUCKET: bucket = "uploads" } = process.env;
	return url && key ? { url: url.replace(/\/$/, ""), key, bucket } : null;
}

// Image uploads need a public Supabase Storage bucket; without one the editor works without them.
export function isImageStorageConfigured() {
	return Boolean(getSettings());
}

function getBucket() {
	const settings = getSettings();
	if (!settings) throw new Error("Image storage is not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
	client ??= new StorageClient(`${settings.url}/storage/v1`, {
		apikey: settings.key,
		Authorization: `Bearer ${settings.key}`,
	});
	return client.from(settings.bucket);
}

// A random suffix keeps every upload at its own URL: a new image never replaces one an email shows.
function withSuffix(pathname) {
	const suffix = crypto.randomBytes(6).toString("hex");
	const dot = pathname.lastIndexOf(".");
	return dot > pathname.lastIndexOf("/") ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
}

export async function putImage(pathname, bytes, contentType) {
	const bucket = getBucket();
	const path = withSuffix(pathname);
	const { error } = await bucket.upload(path, bytes, { contentType, cacheControl: String(ONE_YEAR), upsert: false });
	if (error) throw error;
	return bucket.getPublicUrl(path).data.publicUrl;
}
