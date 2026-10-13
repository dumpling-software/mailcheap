"use client";

import { useDeferredValue, useMemo, useState } from "react";
import PreviewEmail from "@/components/PreviewEmail";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CONTENT_SLOT, FOOTER_SLOT, validateTemplate } from "@/lib/email-template";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "@/lib/render-email";

// Every kind of block a campaign can have, so the preview shows the whole design.
const SAMPLE_MARKDOWN = `Hi friend,

Here's what we shipped this month. This paragraph has [a link](https://example.com), **bold** and *italic* text.

## A section heading

- A list item
- Another one

[[Try it now]](https://example.com)

:::box
A box sets an update apart.
:::

PS: Reply to this email if you need a hand.`;

export default function SectionTemplate({ template, onChange, newsletter, sender, stagger }) {
	const [isOpen, setIsOpen] = useState(false);
	const deferred = useDeferredValue(newsletter);
	const problem = validateTemplate(template);
	const html = useMemo(
		() =>
			isOpen
				? renderEmail({ markdown: SAMPLE_MARKDOWN, subject: "Template preview", newsletter: deferred }).html.replaceAll(
						UNSUBSCRIBE_PLACEHOLDER,
						"#"
					)
				: "",
		[isOpen, deferred]
	);

	function update(key) {
		return (event) => onChange({ ...template, [key]: event.target.value });
	}

	return (
		<section style={{ "--stagger": stagger }} className="rounded-xl bg-card shadow-border animate-enter">
			<div className="flex h-12 items-center justify-between gap-3 px-4">
				<h2 className="text-sm font-medium">Email template</h2>
				<Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen((open) => !open)}>
					{isOpen ? "Hide" : "Edit"}
				</Button>
			</div>
			<p className="border-t border-border/60 px-4 py-3 text-sm text-pretty text-muted-foreground">
				{template.layout.trim()
					? "Campaigns, automations and welcome emails written here use this product's design."
					: "Using the built-in design. Add a layout to give this product's emails its own look."}
			</p>
			{/* Hidden while closed, so the form still sends the template. */}
			<div hidden={!isOpen} className="divide-y divide-border/60 border-t border-border/60">
				<label className="grid gap-2 px-4 py-3">
					<span className="text-sm text-muted-foreground">
						Layout: a whole HTML email with {CONTENT_SLOT} where the text goes and {FOOTER_SLOT} for the
						unsubscribe footer. {"{{subject}}"} and {"{{preview_text}}"} are filled in too.
					</span>
					<Textarea
						name="templateLayout"
						value={template.layout}
						onChange={update("layout")}
						spellCheck={false}
						className="min-h-64 font-mono text-[12px] leading-5"
					/>
				</label>
				<label className="grid gap-2 px-4 py-3">
					<span className="text-sm text-muted-foreground">
						CSS for the text. Rules for .body h2, .body p, .body a… and .btn, .btn-cell (buttons) are also
						copied inline, for clients that drop styles.
					</span>
					<Textarea
						name="templateCss"
						value={template.css}
						onChange={update("css")}
						spellCheck={false}
						className="min-h-40 font-mono text-[12px] leading-5"
					/>
				</label>
				{problem && <p className="px-4 py-3 text-sm text-amber-600 dark:text-amber-400">{problem}</p>}
				<div className="flex justify-end px-4 py-3">
					<Button type="button" variant="outline" size="sm" onClick={() => onChange({ layout: "", css: "" })}>
						Use the built-in design
					</Button>
				</div>
				{isOpen && (
					<div className="p-3">
						<PreviewEmail html={html} sender={sender} subject="Template preview" fit="content" />
					</div>
				)}
			</div>
		</section>
	);
}
