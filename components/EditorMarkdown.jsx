"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { IMAGE_TYPES, prepareImage, uploadImage } from "@/lib/upload-image";

// Stands in for a picture while it uploads; sending waits until none are left.
export const UPLOADING_IMAGE_PREFIX = "](uploading:";

// Markdown as typed, previewed by renderEmail next to it. Also the body editor of automation emails.
// Pasted or dropped pictures upload and become ![](url) where the cursor is.
export default function EditorMarkdown({ value, onChange, placeholder = "Write in Markdown…", minHeight = 560, label = "Markdown" }) {
	const latest = useRef({ value, onChange });
	useEffect(() => {
		latest.current = { value, onChange };
	});

	function insertImages(event, files) {
		const images = [...files].filter((file) => IMAGE_TYPES.includes(file.type));
		if (images.length === 0) return;
		event.preventDefault();
		const textarea = event.currentTarget;
		const position = textarea.selectionStart ?? value.length;
		const placeholders = images.map((file, index) => `![${file.name.replace(/[[\]]/g, "")}${UPLOADING_IMAGE_PREFIX}${Date.now()}-${index})`);
		const before = value.slice(0, position);
		const insert = `${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${placeholders.join("\n\n")}\n\n`;
		onChange(`${before}${insert}${value.slice(position)}`);

		images.forEach(async (file, index) => {
			const marker = placeholders[index];
			let replacement = "";
			try {
				const image = await prepareImage(file);
				replacement = `![](${await uploadImage(image.file)})`;
			} catch (error) {
				toast.error(error.message);
			}
			const current = latest.current.value;
			if (current.includes(marker)) latest.current.onChange(current.replace(marker, () => replacement));
		});
	}

	return (
		<div className="relative">
			<span className="pointer-events-none absolute top-3 right-4 text-xs text-muted-foreground">{label}</span>
			<textarea
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onPaste={(event) => insertImages(event, event.clipboardData.files)}
				onDrop={(event) => insertImages(event, event.dataTransfer.files)}
				placeholder={placeholder}
				spellCheck
				aria-label="Content"
				style={{ minHeight }}
				className="block w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
			/>
		</div>
	);
}
