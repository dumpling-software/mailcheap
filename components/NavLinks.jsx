"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Globe, KeyRound, LayoutGrid, Mail, Send, Settings2, ShieldCheck, Users, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

export default function NavLinks({ onNavigate }) {
	const pathname = usePathname();

	return (
		<nav className="flex flex-col gap-0.5">
			{NAV_ITEMS.map(({ href, label, icon: Icon, also = [], heading }) => {
				const isActive = href === "/" ? pathname === "/" : [href, ...also].some((prefix) => pathname.startsWith(prefix));
				return [
					heading && (
						<p key={heading} className="mt-5 mb-1 px-2.5 text-xs font-medium text-muted-foreground">
							{heading}
						</p>
					),
					<Link
						key={href}
						href={href}
						onClick={onNavigate}
						aria-current={isActive ? "page" : undefined}
						className={cn(
							"flex h-9 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-sm font-medium transition-colors duration-150",
							isActive
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						)}
					>
						<Icon className="size-4" />
						{label}
					</Link>,
				];
			})}
		</nav>
	);
}

// The first five work on the product picked above them; the rest are for the whole account.
const NAV_ITEMS = [
	{ href: "/", label: "Overview", icon: LayoutGrid },
	{ href: "/campaigns", label: "Campaigns", icon: Send },
	{ href: "/automations", label: "Automations", icon: Workflow },
	{ href: "/contacts", label: "Contacts", icon: Users },
	{ href: "/settings", label: "Settings", icon: Settings2, also: ["/newsletters"] },
	{ href: "/transactional", label: "Transactional", icon: Mail, heading: "Account" },
	{ href: "/domains", label: "Domains", icon: Globe },
	{ href: "/api-keys", label: "API keys", icon: KeyRound },
	{ href: "/email-checks", label: "Email checks", icon: ShieldCheck },
];
