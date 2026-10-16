"use client";

import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// A table row that opens href when clicked anywhere outside its own links and buttons. A link stretched
// over the row with ::after relies on position:relative on <tr>, which iOS Safari doesn't honor: every
// row's link covered the whole table and the last one caught every tap.
export default function TableRowLink({ href, className, children }) {
	const router = useRouter();

	function open(event) {
		// Clicks in portaled menus and dialogs bubble here through React, but aren't inside the row.
		if (!event.currentTarget.contains(event.target)) return;
		if (event.target.closest("a, button, input, [role='menuitem']")) return;
		if (window.getSelection()?.toString()) return;
		if (event.metaKey || event.ctrlKey) window.open(href, "_blank", "noopener");
		else router.push(href);
	}

	return (
		<TableRow onClick={open} className={cn("cursor-pointer", className)}>
			{children}
		</TableRow>
	);
}
