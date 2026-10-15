"use client";

import { useRef, useState, useTransition } from "react";
import { ImagePlus, Loader2, Sparkles, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { draftWithAi } from "@/app/(app)/campaigns/ai-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IMAGE_TYPES, prepareImage, uploadImage } from "@/lib/upload-image";

const MAX_IMAGES = 10;

// Paste the copy, add links and pictures, and Claude writes the email in the product's Markdown.
// The result goes straight into the editor; Undo puts back what was there.
export default function PanelAiDraft({ campaignId, values, onApply, onUndo, canUndo }) {
	const [isOpen, setIsOpen] = useState(false);
	const [brief, setBrief] = useState("");
	const [changes, setChanges] = useState("");
	const [images, setImages] = useState([]);
	const [isWritingMeta, setIsWritingMeta] = useState(!values.subject.trim());
	const [isPending, startTransition] = useTransition();
	const [lastDraft, setLastDraft] = useState(null);
	const fileInput = useRef(null);
	const isUploading = images.some(({ url }) => !url);
	const hasBody = Boolean(values.body.replace(/<[^>]*>/g, "").trim());

	async function addImages(files) {
		const picked = [...files].filter((file) => IMAGE_TYPES.includes(file.type)).slice(0, MAX_IMAGES - images.length);
		for (const file of picked) {
			const id = `${Date.now()}-${Math.random()}`;
			setImages((current) => [...current, { id, previewUrl: URL.createObjectURL(file), url: null }]);
			try {
				const image = await prepareImage(file);
				const url = await uploadImage(image.file);
				setImages((current) => current.map((item) => (item.id === id ? { ...item, url } : item)));
			} catch (error) {
				toast.error(error.message);
				setImages((current) => current.filter((item) => item.id !== id));
			}
		}
	}

	function run(mode) {
		startTransition(async () => {
			const isRefine = mode === "refine";
			const result = await draftWithAi(campaignId, {
				brief: isRefine ? changes : brief,
				imageUrls: images.map(({ url }) => url).filter(Boolean),
				mode,
				draft: isRefine ? { subject: values.subject, previewText: values.previewText, markdown: values.body } : null,
			});
			if (result?.error) return void toast.error(result.error);
			onApply(result.draft, { withMeta: isWritingMeta || isRefine });
			setLastDraft(result.draft);
			if (isRefine) setChanges("");
			toast.success(isRefine ? "Draft updated" : "Draft written. Check it before sending.");
		});
	}

	if (!isOpen) {
		return (
			<button
				type="button"
				onClick={() => setIsOpen(true)}
				className="flex h-11 w-full items-center gap-2 border-b border-border/60 px-4 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground"
			>
				<Sparkles className="size-4" />
				Write with AI: paste your copy, links and pictures
			</button>
		);
	}

	return (
		<div className="flex flex-col gap-3 border-b border-border/60 bg-muted/30 px-4 py-3">
			<div className="flex items-center justify-between gap-3">
				<span className="flex items-center gap-2 text-sm font-medium">
					<Sparkles className="size-4" />
					Write with AI
				</span>
				<Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={() => setIsOpen(false)}>
					<X />
				</Button>
			</div>
			<Textarea
				value={brief}
				onChange={(event) => setBrief(event.target.value)}
				onPaste={(event) => {
					if (event.clipboardData.files.length > 0) {
						event.preventDefault();
						addImages(event.clipboardData.files);
					}
				}}
				placeholder={"Paste the email copy. Say where buttons go, e.g. \"CTA: Try it now → https://dash.poof.bg/studio\"."}
				className="min-h-40 bg-background text-sm"
			/>
			<div
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					addImages(event.dataTransfer.files);
				}}
				className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-background p-2"
			>
				{images.map(({ id, previewUrl, url }) => (
					<div key={id} className="relative size-16 overflow-hidden rounded-md bg-muted">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src={url ?? previewUrl} alt="" className="size-full object-cover" />
						{!url && <Loader2 className="absolute inset-0 m-auto size-4 animate-spin text-white drop-shadow" />}
						<button
							type="button"
							aria-label="Remove picture"
							onClick={() => setImages((current) => current.filter((item) => item.id !== id))}
							className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-white"
						>
							<X className="size-3" />
						</button>
					</div>
				))}
				<button
					type="button"
					onClick={() => fileInput.current?.click()}
					className="flex h-16 items-center gap-2 rounded-md px-3 text-xs text-muted-foreground hover:text-foreground"
				>
					<ImagePlus className="size-4" />
					Drop pictures here, or pick them
				</button>
				<input
					ref={fileInput}
					type="file"
					accept={IMAGE_TYPES.join(",")}
					multiple
					hidden
					onChange={(event) => {
						addImages(event.target.files);
						event.target.value = "";
					}}
				/>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<label className="flex items-center gap-2 text-xs text-muted-foreground">
					<input type="checkbox" checked={isWritingMeta} onChange={(event) => setIsWritingMeta(event.target.checked)} />
					Also write the subject and preview text
				</label>
				<div className="flex items-center gap-2">
					{canUndo && (
						<Button type="button" variant="ghost" size="sm" onClick={onUndo} disabled={isPending}>
							<Undo2 />
							Undo
						</Button>
					)}
					<Button type="button" size="sm" onClick={() => run("create")} disabled={isPending || isUploading || !brief.trim()}>
						{isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
						{hasBody ? "Format (replaces the content)" : "Format"}
					</Button>
				</div>
			</div>
			{lastDraft && (
				<div className="flex items-end gap-2">
					<Textarea
						value={changes}
						onChange={(event) => setChanges(event.target.value)}
						placeholder="Ask for changes, e.g. “shorter intro, move the picture under the heading”"
						className="min-h-10 bg-background text-sm"
						rows={1}
					/>
					<Button type="button" variant="outline" size="sm" onClick={() => run("refine")} disabled={isPending || !changes.trim()}>
						Apply
					</Button>
				</div>
			)}
		</div>
	);
}
