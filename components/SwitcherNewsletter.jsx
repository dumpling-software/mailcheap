"use client";

import { useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Loader2, Plus, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { selectNewsletter } from "@/app/(app)/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Pages under these belong to one newsletter: switching leaves them for the section's list.
const SECTIONS_WITH_DETAIL_PAGES = ["/campaigns/", "/automations/", "/contacts/", "/newsletters/"];

export default function SwitcherNewsletter({ newsletters, currentId, onNavigate }) {
	const router = useRouter();
	const pathname = usePathname();
	const [isPending, startTransition] = useTransition();
	const current = newsletters.find(({ id }) => id === currentId);

	function select(id) {
		if (id === currentId) return;
		startTransition(async () => {
			const result = await selectNewsletter(id);
			if (result?.error) {
				toast.error(result.error);
				return;
			}
			const section = SECTIONS_WITH_DETAIL_PAGES.find((prefix) => pathname.startsWith(prefix));
			if (section === "/newsletters/") router.push("/settings");
			else if (section) router.push(section.slice(0, -1));
			else router.refresh();
			onNavigate?.();
		});
	}

	if (!current) {
		return (
			<Link
				href="/newsletters/new"
				onClick={onNavigate}
				className="flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground shadow-border transition-colors duration-150 hover:bg-muted/60 hover:text-foreground"
			>
				<Plus className="size-4" />
				Add a product
			</Link>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="flex h-11 w-full items-center gap-2.5 rounded-lg pr-2 pl-1.5 text-left shadow-border transition-colors duration-150 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-muted/60"
				aria-label={`Product: ${current.name}`}
			>
				<AvatarNewsletter newsletter={current} size={28} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-[11px] leading-4 text-muted-foreground">Product</span>
					<span className="truncate text-sm leading-5 font-medium">{current.name}</span>
				</span>
				{isPending ? (
					<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
				) : (
					<ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Products</DropdownMenuLabel>
				{newsletters.map((newsletter) => (
					<DropdownMenuItem key={newsletter.id} onSelect={() => select(newsletter.id)} className="gap-2.5 py-1.5">
						<AvatarNewsletter newsletter={newsletter} size={24} />
						<span className="flex-1 truncate">{newsletter.name}</span>
						{newsletter.id === currentId && <Check className="size-4" />}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild className="gap-2.5">
					<Link href="/newsletters" onClick={onNavigate}>
						<Rows3 className="size-4" />
						All products
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild className="gap-2.5">
					<Link href="/newsletters/new" onClick={onNavigate}>
						<Plus className="size-4" />
						Add a product
					</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
