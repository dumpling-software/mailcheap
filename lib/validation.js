const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_ID_PATTERN = /^[0-9a-f]{32}$/i;
// Dot-atom local part and hostname labels: rejects quoted strings, commas, and display names.
const EMAIL_PATTERN =
	/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
// Issue bodies from the API and the editor. Archive pages clean them on each render.
export const MAX_BODY_BYTES = 500_000;

// Row ids are UUIDs.
export function isUuid(value) {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

// Tracking links carry ids without dashes: 32 hex characters instead of 36, in every link of every email.
export function toCompactId(id) {
	return String(id).toLowerCase().replaceAll("-", "");
}

export function fromCompactId(value) {
	if (typeof value !== "string" || !COMPACT_ID_PATTERN.test(value)) return null;
	const hex = value.toLowerCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEmail(value) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length > MAX_EMAIL_LENGTH || email.indexOf("@") > MAX_LOCAL_PART_LENGTH) return null;
	return EMAIL_PATTERN.test(email) ? email : null;
}

// "Dana <dana@example.com>" or a bare address, as mail headers and SES events give them.
export function normalizeAddress(value) {
	const match = /<([^<>]+)>\s*$/.exec(String(value ?? ""));
	return normalizeEmail(match ? match[1] : value);
}
