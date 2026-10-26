import { ShieldCheck } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCopy from "@/components/ButtonCopy";
import { ButtonDeleteEmailRule, FormEmailRule, FormTestEmail } from "@/components/FormEmailChecks";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAppUrl } from "@/lib/config";
import { listEmailRules } from "@/lib/email-check";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Email checks" };

export default async function EmailChecksPage() {
	const rules = await listEmailRules();
	const example = `curl -X POST ${getAppUrl()}/api/v1/email-check \\
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"jane@example.com"}'
# {"email":"jane@example.com","accepted":false,"reason":"disposable","message":"Disposable email addresses aren't accepted. ..."}`;

	return (
		<>
			<HeaderPage title="Email checks" />

			<div className="flex flex-col gap-8">
				<p className="max-w-2xl text-sm text-muted-foreground animate-enter">
					Every signup, from the API, your apps and website forms, is checked here first. Disposable addresses, blocked
					addresses and domains that can&apos;t receive email are refused with a message for the person signing up.
					Domains are looked up in the community disposable lists, then verifymail.io
					{process.env.VERIFYMAIL_API_KEY ? "" : " (off: set VERIFYMAIL_API_KEY)"}, then DeBounce, then DNS.
				</p>

				<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Check an address</h2>
					<FormTestEmail />
				</section>

				<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Rules</h2>
					<p className="text-sm text-muted-foreground">
						Block a domain (with its subdomains) or an address (with any +tag). Allow one the checks get wrong.
					</p>
					<FormEmailRule />
					{rules.length === 0 ? (
						<StateEmpty icon={ShieldCheck} title="No rules yet" />
					) : (
						<div className="overflow-hidden rounded-xl shadow-border">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="pl-4">Domain or address</TableHead>
										<TableHead>Rule</TableHead>
										<TableHead className="hidden md:table-cell">Note</TableHead>
										<TableHead className="hidden sm:table-cell">Added</TableHead>
										<TableHead className="w-24 pr-2" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{rules.map((rule) => (
										<TableRow key={rule._id}>
											<TableCell className="py-2.5 pl-4 font-mono text-[13px]">{rule.value}</TableCell>
											<TableCell>
												<BadgeStatus status={rule.action === "block" ? "blocked" : "allowed"} />
											</TableCell>
											<TableCell className="hidden text-sm text-muted-foreground md:table-cell">{rule.note}</TableCell>
											<TableCell className="hidden text-muted-foreground sm:table-cell">{formatDate(rule.createdAt)}</TableCell>
											<TableCell className="pr-2 text-right">
												<ButtonDeleteEmailRule id={rule._id} value={rule.value} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</section>

				<section style={{ "--stagger": 3 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Check from your app&apos;s signup</h2>
					<div className="overflow-hidden rounded-xl bg-card shadow-border">
						<div className="flex h-10 items-center justify-between border-b border-border/60 pr-2 pl-4">
							<span className="text-sm">Any API key works</span>
							<ButtonCopy value={example} label="Copy" />
						</div>
						<pre className="overflow-x-auto p-4 font-mono text-xs leading-5 text-muted-foreground">{example}</pre>
					</div>
				</section>
			</div>
		</>
	);
}
