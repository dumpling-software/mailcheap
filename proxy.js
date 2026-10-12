import { NextResponse } from "next/server";
import { isAccessEnabled, readAccessToken, verifyAccessToken } from "@/lib/access";
import { getArchiveHostUrl, getArchiveSlugForHost } from "@/lib/archive-hosts";
import { isArchiveEnabled } from "@/lib/config";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

// Reachable without a session: recipients, mail providers, AWS, QStash, and API-key clients.
const PUBLIC_PATHS = [
	/^\/favicon\.ico$/,
	/^\/login$/,
	/^\/api\/health$/,
	/^\/unsubscribe$/,
	/^\/confirm$/,
	/^\/keep$/,
	/^\/o\//,
	/^\/c\//,
	/^\/api\/unsubscribe$/,
	/^\/api\/views$/,
	/^\/api\/v1\//,
	/^\/api\/webhooks\//,
	/^\/api\/jobs\//,
];

// Archive pages are public only while archives are on (ARCHIVE_ENABLED).
const ARCHIVE_PATHS = [/^\/p\//, /^\/archive\//];

// A public archive domain never exposes the dashboard, not even its login page.
const ARCHIVE_HOST_PATHS = [/^\/unsubscribe$/, /^\/api\/unsubscribe$/, /^\/api\/views$/];
const ISSUE_PATH_PATTERN = /^\/p\/([a-z0-9][a-z0-9-]{0,119})\/?$/;
const AUTHOR_PATH_PATTERN = /^\/authors\/([a-z0-9][a-z0-9-]{0,59})\/?$/;
// Generated share images stay on the app domain, where social cards point: they're only PNGs.
const ARCHIVE_IMAGE_PATH_PATTERN = /^\/archive\/[^/]+\/og$/;

function rewriteTo(request, pathname) {
	const url = request.nextUrl.clone();
	url.pathname = pathname;
	return NextResponse.rewrite(url);
}

export async function proxy(request) {
	const { pathname } = request.nextUrl;
	const isArchiveOn = isArchiveEnabled();
	const isArchivePath = ARCHIVE_PATHS.some((pattern) => pattern.test(pathname));

	// With archives off they don't exist: no issue pages, no archive domains, no redirects.
	if (!isArchiveOn && isArchivePath) return new NextResponse("Not found", { status: 404 });

	const archiveSlug = isArchiveOn ? getArchiveSlugForHost(request.headers.get("host")) : null;
	if (archiveSlug) {
		if (pathname === "/") return rewriteTo(request, `/archive/${archiveSlug}`);
		if (pathname === "/sitemap.xml") return rewriteTo(request, `/archive/${archiveSlug}/sitemap`);
		if (pathname === "/robots.txt") return rewriteTo(request, `/archive/${archiveSlug}/robots`);
		const issueSlug = ISSUE_PATH_PATTERN.exec(pathname)?.[1];
		if (issueSlug) return rewriteTo(request, `/archive/${archiveSlug}/p/${issueSlug}`);
		const authorSlug = AUTHOR_PATH_PATTERN.exec(pathname)?.[1];
		if (authorSlug) return rewriteTo(request, `/archive/${archiveSlug}/authors/${authorSlug}`);
		if (ARCHIVE_HOST_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
		return new NextResponse("Not found", { status: 404 });
	}

	// Issues carry HTML from the API and the editor. A newsletter with its own domain is read there, so that
	// HTML never shares the dashboard's origin; without one, the sanitizer, the frame's sandbox and the CSP
	// guard it here. Local dev keeps every archive under /archive.
	if (pathname.startsWith("/archive/") && process.env.NODE_ENV === "production" && !ARCHIVE_IMAGE_PATH_PATTERN.test(pathname)) {
		const archiveUrl = getArchiveHostUrl(pathname, request.nextUrl.search);
		if (archiveUrl) return NextResponse.redirect(archiveUrl, 308);
	}

	if (isArchivePath || PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();

	// Behind Cloudflare Access, its token is the session, and there's no login page to send anyone to.
	if (isAccessEnabled()) {
		if (await verifyAccessToken(readAccessToken(request.headers, request.cookies))) return NextResponse.next();
		return NextResponse.json({ error: "Unauthorized: sign in through Cloudflare Access" }, { status: 401 });
	}

	const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
	if (session) return NextResponse.next();

	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const login = new URL("/login", request.url);
	if (pathname !== "/") login.searchParams.set("next", pathname);
	return NextResponse.redirect(login);
}

// favicon.ico goes through the proxy so archive domains answer 404 and browsers keep the newsletter's logo.
export const config = {
	matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|svg|jpg|webp)$).*)"],
};
