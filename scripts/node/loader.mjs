import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const NEXT_SERVER = `
export class NextResponse extends Response {
	static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init?.headers } }); }
	static redirect(url, status = 307) { return new NextResponse(null, { status, headers: { Location: String(url) } }); }
	static next() { return new NextResponse(null, { headers: { "x-middleware-next": "1" } }); }
	static rewrite(url) { return new NextResponse(null, { headers: { "x-middleware-rewrite": String(url) } }); }
}
export const pending = [];
export function after(task) { pending.push(Promise.resolve().then(typeof task === "function" ? task : () => task)); }
`;
const STUBS = {
	"server-only": "export {};",
	"next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
	"next/headers": "export async function headers() { return new Headers(); } export async function cookies() { return { get() {} }; }",
	"next/server": NEXT_SERVER,
	"next/navigation": "export function notFound() { throw new Error('NEXT_NOT_FOUND'); } export function redirect(url) { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); }",
};

// Lets node (tests, scripts) load app modules: "@/x" resolves like jsconfig's alias, extensionless imports get
// .js, and Next-only modules become small stand-ins (after() tasks collect in "next/server" pending).
function withExtension(url) {
	if (/\.[cm]?js$|\.jsx$|\.json$/.test(url.pathname)) return url;
	for (const extension of [".js", ".jsx", "/index.js"]) {
		const candidate = new URL(`${url.href}${extension}`);
		if (existsSync(fileURLToPath(candidate))) return candidate;
	}
	return url;
}

export async function resolve(specifier, context, nextResolve) {
	if (Object.hasOwn(STUBS, specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
	if (specifier.startsWith("@/")) {
		return { url: withExtension(new URL(specifier.slice(2), ROOT)).href, shortCircuit: true };
	}
	if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
		const url = withExtension(new URL(specifier, context.parentURL));
		if (url.pathname.startsWith(fileURLToPath(ROOT)) && !url.pathname.includes("/node_modules/")) {
			return { url: url.href, shortCircuit: true };
		}
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
	return nextLoad(url, context);
}
