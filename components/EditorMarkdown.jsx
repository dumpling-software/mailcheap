"use client";

// Markdown as typed, previewed by renderEmail next to it. Also the body editor of automation emails.
export default function EditorMarkdown({ value, onChange, placeholder = "Write in Markdown…", minHeight = 560, label = "Markdown" }) {
	return (
		<div className="relative">
			<span className="pointer-events-none absolute top-3 right-4 text-xs text-muted-foreground">{label}</span>
			<textarea
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				spellCheck
				aria-label="Content"
				style={{ minHeight }}
				className="block w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
			/>
		</div>
	);
}
