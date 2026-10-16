import "server-only";
import { Resolver } from "node:dns/promises";
import { getDmarcHosts, getDmarcStatus } from "@/lib/dmarc-rules";

// The Domains page waits for these lookups, so they give up within seconds.
const resolver = new Resolver({ timeout: 2000, tries: 2 });
// No such name, or no record of that type: an answer, unlike a resolver that failed.
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

// The DMARC record that covers mail from a domain, as receivers find it: { status, host } with status found,
// multiple or invalid, missing when no host has one, or unknown when DNS didn't answer.
export async function checkDmarc(domain) {
	for (const host of getDmarcHosts(domain)) {
		let records;
		try {
			records = await resolver.resolveTxt(`_dmarc.${host}`);
		} catch (error) {
			if (!NO_RECORD.has(error.code)) return { status: "unknown", host };
			records = [];
		}
		const status = getDmarcStatus(records);
		if (status) return { status, host };
	}
	return { status: "missing", host: null };
}
