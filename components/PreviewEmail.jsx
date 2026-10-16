"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, Monitor, Smartphone } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { cn } from "@/lib/utils";

// fit="fill" stretches to the parent's height (editor); fit="content" grows to the email (report).
// Full screen shows the email over the whole window, at real desktop width; Escape closes it.
export default function PreviewEmail({
	html,
	toolbar,
	sender,
	subject,
	previewText,
	fit = "fill",
	className,
}) {
	const [device, setDevice] = useState("desktop");
	const [contentHeight, setContentHeight] = useState(null);
	const [isFullScreen, setIsFullScreen] = useState(false);
	const frameRef = useRef(null);
	const isContentFit = fit === "content" && !isFullScreen;

	useEffect(() => {
		if (!isContentFit) return;
		const frame = frameRef.current;
		// Measured after the width transition, since the email reflows at each width.
		const timeout = setTimeout(() => {
			const root = frame?.contentDocument?.documentElement;
			if (root) setContentHeight(root.scrollHeight);
		}, 350);
		return () => clearTimeout(timeout);
	}, [device, isContentFit]);

	useEffect(() => {
		if (!isFullScreen) return;
		const close = (event) => event.key === "Escape" && setIsFullScreen(false);
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [isFullScreen]);

	const preview = (
		<div
			className={cn(
				"flex flex-col overflow-hidden bg-card",
				isFullScreen ? "fixed inset-0 z-50" : cn("rounded-xl shadow-border", className)
			)}
		>
			<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 pr-3 pl-2">
				<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
					{DEVICES.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							aria-label={label}
							aria-pressed={device === id}
							onClick={() => {
								setDevice(id);
								if (isContentFit) setContentHeight(null);
							}}
							className={cn(
								"relative grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,box-shadow] duration-150 after:absolute after:-inset-1 hover:text-foreground",
								device === id && "bg-background text-foreground shadow-border"
							)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
				<div className="flex items-center gap-2">
					{toolbar}
					<button
						type="button"
						aria-label={isFullScreen ? "Exit full screen" : "Full screen"}
						title={isFullScreen ? "Exit full screen (Esc)" : "Full screen"}
						onClick={() => setIsFullScreen((current) => !current)}
						className="relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 after:absolute after:-inset-1 hover:text-foreground"
					>
						{isFullScreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
					</button>
				</div>
			</div>

			{sender && (
				<div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
					<AvatarNewsletter newsletter={sender} size={40} className="rounded-full" />
					<div className="min-w-0 flex-1 text-sm">
						<p className="truncate">
							<span className="font-semibold">{sender.fromName || sender.name}</span>{" "}
							<span className="text-muted-foreground">&lt;{sender.fromEmail}&gt;</span>
						</p>
						<p className="truncate">
							<span className="font-medium">{subject || "No subject"}</span>
							{previewText && <span className="text-muted-foreground"> — {previewText}</span>}
						</p>
					</div>
				</div>
			)}

			<div className="flex min-h-0 flex-1 justify-center bg-muted/50 p-3 sm:p-5">
				<iframe
					ref={frameRef}
					title="Email preview"
					// Same origin lets the report read the email's height; without allow-scripts nothing in it runs.
					sandbox={fit === "content" ? "allow-same-origin" : ""}
					srcDoc={html}
					onLoad={(event) => {
						if (!isContentFit) return;
						const root = event.currentTarget.contentDocument?.documentElement;
						if (root) setContentHeight(root.scrollHeight);
					}}
					style={isContentFit ? { height: contentHeight ?? 640 } : undefined}
					className={cn(
						"max-w-full rounded-lg bg-white shadow-border transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
						isFullScreen ? "h-full" : isContentFit ? "min-h-96" : "h-[640px] lg:h-full",
						device === "mobile" ? "w-[375px]" : isFullScreen ? "w-full max-w-[1000px]" : "w-full max-w-[760px]"
					)}
				/>
			</div>
		</div>
	);
	// On the page's body, so no parent's layout keeps it inside the editor column.
	return isFullScreen ? createPortal(preview, document.body) : preview;
}

const DEVICES = [
	{ id: "desktop", label: "Desktop", icon: Monitor },
	{ id: "mobile", label: "Mobile", icon: Smartphone },
];
