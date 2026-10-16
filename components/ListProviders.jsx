import { Globe } from "lucide-react";
import ImageFavicon from "@/components/ImageFavicon";
import TextEmpty from "@/components/TextEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatRate } from "@/lib/format";
import { PROVIDER_DOMAINS, PROVIDER_LABELS } from "@/lib/providers";

// Delivery by mailbox provider. Opens and clicks only for email Mailcheap tracks itself.
export default function ListProviders({ providers, engagement = true }) {
	return (
		<Table>
			<TableHeader>
				<TableRow className="hover:bg-transparent">
					<TableHead className="pl-4">Inbox</TableHead>
					<TableHead className="text-right">Sent</TableHead>
					<TableHead className="text-right">Delivered</TableHead>
					{engagement && <TableHead className="text-right">Opened</TableHead>}
					{engagement && <TableHead className="hidden text-right sm:table-cell">Clicked</TableHead>}
					<TableHead className={engagement ? "hidden text-right sm:table-cell" : "text-right"}>Bounced</TableHead>
					<TableHead className="pr-4 text-right">Complaints</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{providers.map((row) => (
					<TableRow key={row.provider} className="tabular-nums">
						<TableCell className="pl-4 font-medium">
							<span className="flex items-center gap-2.5">
								{PROVIDER_DOMAINS[row.provider] ? (
									<ImageFavicon domain={PROVIDER_DOMAINS[row.provider]} size={16} />
								) : (
									<Globe className="size-4 text-muted-foreground" />
								)}
								{PROVIDER_LABELS[row.provider] || PROVIDER_LABELS.other}
							</span>
						</TableCell>
						<TableCell className="text-right">{formatNumber(row.sent)}</TableCell>
						<TableCell className="text-right">{formatRate(row.delivered, row.sent) ?? <TextEmpty />}</TableCell>
						{engagement && (
							<TableCell className="text-right">{formatRate(row.opened, row.delivered) ?? <TextEmpty />}</TableCell>
						)}
						{engagement && (
							<TableCell className="hidden text-right sm:table-cell">
								{formatRate(row.clicked, row.delivered) ?? <TextEmpty />}
							</TableCell>
						)}
						<TableCell className={engagement ? "hidden text-right sm:table-cell" : "text-right"}>
							{formatRate(row.bounced, row.sent, 2) ?? <TextEmpty />}
						</TableCell>
						<TableCell className="pr-4 text-right">{formatRate(row.complained, row.sent, 3) ?? <TextEmpty />}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
