import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access in front of the dashboard (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD) replaces the password login.
// Access signs every request it lets through; checking that token here keeps the raw origin URL (Railway's)
// closed to anyone who skips Cloudflare.
export const ACCESS_HEADER = "cf-access-jwt-assertion";
export const ACCESS_COOKIE = "CF_Authorization";
// Signing out has to end the Access session, or the next request signs straight back in.
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export function getAccessConfig(env = process.env) {
	const team = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
	const aud = (env.CF_ACCESS_AUD ?? "").trim();
	return team && aud ? { team, aud } : null;
}

export function isAccessEnabled(env = process.env) {
	return getAccessConfig(env) !== null;
}

let remoteKeys = null;

function getKeys(team) {
	if (remoteKeys?.team !== team) {
		remoteKeys = { team, keys: createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`)) };
	}
	return remoteKeys.keys;
}

// The header comes from Cloudflare on every request; the cookie is there for the browser's own requests.
export function readAccessToken(headers, cookies) {
	return headers.get(ACCESS_HEADER) || cookies.get(ACCESS_COOKIE)?.value || null;
}

// { email } for a valid Access token, otherwise null. `keys` is for tests.
export async function verifyAccessToken(token, { config = getAccessConfig(), keys } = {}) {
	if (!token || !config) return null;
	try {
		const { payload } = await jwtVerify(token, keys ?? getKeys(config.team), {
			issuer: `https://${config.team}`,
			audience: config.aud,
			algorithms: ["RS256"],
		});
		return typeof payload.email === "string" && payload.email ? { email: payload.email } : null;
	} catch {
		return null;
	}
}

