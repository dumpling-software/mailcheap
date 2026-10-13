"use client";

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, Copy, FlaskConical, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { convertCampaignToMarkdown, duplicateCampaign, saveCampaign, sendTestCampaign } from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import DialogDiscardCampaign from "@/components/DialogDiscardCampaign";
import DialogScheduleCampaign from "@/components/DialogScheduleCampaign";
import DialogSendCampaign from "@/components/DialogSendCampaign";
import EditorMarkdown, { UPLOADING_IMAGE_PREFIX } from "@/components/EditorMarkdown";
import EditorRich from "@/components/EditorRich";
import HeaderPage from "@/components/HeaderPage";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import ListChecks from "@/components/ListChecks";
import PreviewEmail from "@/components/PreviewEmail";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { markdownToHtml } from "@/lib/markdown";
import { getPresendChecks } from "@/lib/presend-checks";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "@/lib/render-email";
import { slugify } from "@/lib/slug";
import { useAutosave } from "@/lib/use-autosave";

const UPLOADING_MESSAGE = "Wait for images to finish uploading";

export default function FormCampaign({
	campaign,
	newsletter,
	audienceCount,
	isDomainVerified,
	isSendingEnabled,
	testEmail,
	sendTimes,
	archiveUrlBase,
}) {
	const isHtml = campaign.format === "html";
	const [isDiscardOpen, setIsDiscardOpen] = useState(false);
	const [isToRichOpen, setIsToRichOpen] = useState(false);
	const [isToMarkdownOpen, setIsToMarkdownOpen] = useState(false);
	const [isConverting, startConverting] = useTransition();
	const router = useRouter();
	// rich (the editor), markdown (typed as Markdown) or html (a designed document, sent as is).
	const [format, setFormat] = useState(campaign.format === "markdown" ? "markdown" : isHtml ? "html" : "rich");
	// The rich editor reads its content once, when it mounts: switching to it mounts a new one.
	const [richSeed, setRichSeed] = useState(() => ({ key: 0, html: campaign.html }));
	const [values, setValues] = useState({
		subject: campaign.subject,
		previewText: campaign.previewText,
		body: campaign.format === "markdown" ? campaign.markdown : campaign.html,
		format: campaign.format === "markdown" ? "markdown" : isHtml ? "html" : "rich",
	});
	const save = useCallback((snapshot) => saveCampaign(campaign._id, snapshot), [campaign._id]);
	const { isDirty, isSaving, error, flush } = useAutosave(values, save);
	const [isTesting, startTesting] = useTransition();
	const [isWorking, startWorking] = useTransition();
	const deferredValues = useDeferredValue(values);
	const isUploading = values.body.includes('src="blob:') || values.body.includes(UPLOADING_IMAGE_PREFIX);

	const rendered = useMemo(
		() =>
			renderEmail({
				format,
				html: format === "markdown" ? "" : deferredValues.body,
				markdown: format === "markdown" ? deferredValues.body : "",
				subject: deferredValues.subject,
				previewText: deferredValues.previewText,
				newsletter,
			}),
		[format, deferredValues, newsletter]
	);
	const previewHtml = useMemo(
		() => withResponsiveImages(rendered.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#")),
		[rendered.html]
	);
	const { checks, blocking } = getPresendChecks({
		campaign: { ...campaign, ...values },
		newsletter,
		rendered,
		isDomainVerified,
		isSendingEnabled,
	});

	async function persist() {
		if (await flush()) return true;
		toast.error("Couldn't save the draft");
		return false;
	}

	function sendTest() {
		startTesting(async () => {
			if (isUploading) return void toast.error(UPLOADING_MESSAGE);
			if (!(await persist())) return;
			const result = await sendTestCampaign(campaign._id);
			if (result?.error) toast.error(result.error);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	function runAction(action) {
		startWorking(async () => {
			const result = await action(campaign._id);
			if (result?.error) toast.error(result.error);
		});
	}

	const onKeyDown = useEffectEvent((event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			flush();
		}
	});
	const onBeforeUnload = useEffectEvent((event) => {
		if (!isDirty && !isSaving) return;
		flush();
		event.preventDefault();
	});

	useEffect(() => {
		function handleKeyDown(event) {
			onKeyDown(event);
		}
		function handleBeforeUnload(event) {
			onBeforeUnload(event);
		}
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, []);

	function update(key) {
		return (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
	}

	const updateBody = useCallback((body) => setValues((current) => ({ ...current, body })), []);

	// Markdown to rich converts the text once; there's no way back, so it asks first. An empty draft
	// switches either way.
	function switchFormat(next) {
		if (next === format) return;
		if (next === "rich" && values.body.trim()) return setIsToRichOpen(true);
		applyFormat(next);
	}

	function applyFormat(next) {
		const body = next === "rich" && format === "markdown" ? markdownToHtml(values.body) : values.body;
		if (next === "rich") setRichSeed(({ key }) => ({ key: key + 1, html: body }));
		setFormat(next);
		setValues((current) => ({ ...current, body, format: next }));
	}

	const isBodyEmpty = !values.body.replace(/<[^>]*>/g, "").trim();

	function convertToMarkdown() {
		startConverting(async () => {
			// Edits still waiting for autosave go first, so the conversion reads them.
			if (!(await persist())) return;
			const result = await convertCampaignToMarkdown(campaign._id);
			if (result?.error) return void toast.error(result.error);
			setIsToMarkdownOpen(false);
			router.refresh();
		});
	}

	const from = newsletter.fromName
		? `${newsletter.fromName} <${newsletter.fromEmail}>`
		: newsletter.fromEmail;

	return (
		<>
			<HeaderPage
				title={values.subject || "Untitled"}
				backHref="/campaigns"
				icon={<AvatarNewsletter newsletter={newsletter} size={28} />}
				meta={<BadgeStatus status={campaign.status} />}
			>
				<StatusSave isSaving={isDirty || isSaving} error={error} onRetry={flush} />
				<Tooltip>
					<TooltipTrigger asChild>
						<span tabIndex={isSendingEnabled ? -1 : 0} className="rounded-lg">
							<Button variant="outline" onClick={sendTest} disabled={!isSendingEnabled || isTesting}>
								{isTesting ? (
									<Loader2 data-icon="inline-start" className="animate-spin" />
								) : (
									<FlaskConical data-icon="inline-start" />
								)}
								Test
							</Button>
						</span>
					</TooltipTrigger>
					<TooltipContent>{isSendingEnabled ? `Sends to ${testEmail}` : "Sending is off"}</TooltipContent>
				</Tooltip>
				<DialogScheduleCampaign
					campaignId={campaign._id}
					scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
					audienceLimit={campaign.audienceLimit}
					audienceCount={audienceCount}
					history={sendTimes.history}
					taken={sendTimes.taken}
					isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
					blockingMessage={isUploading ? UPLOADING_MESSAGE : blocking[0]?.message}
					onBeforeSchedule={persist}
				/>
				<DialogSendCampaign
					campaignId={campaign._id}
					audienceCount={audienceCount}
					scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
					isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
					blockingMessage={isUploading ? UPLOADING_MESSAGE : blocking[0]?.message}
					onBeforeSend={persist}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="More" disabled={isWorking}>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => runAction(duplicateCampaign)}>
							<Copy />
							Duplicate
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onSelect={() => setIsDiscardOpen(true)}>
							<Trash2 />
							Discard
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Dialog open={isToRichOpen} onOpenChange={setIsToRichOpen}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Switch to the editor?</DialogTitle>
							<DialogDescription>
								The Markdown becomes formatted text in the editor. This draft can&apos;t go back to Markdown afterwards.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<DialogClose asChild>
								<Button variant="outline">Keep Markdown</Button>
							</DialogClose>
							<Button
								onClick={() => {
									setIsToRichOpen(false);
									applyFormat("rich");
								}}
							>
								Switch
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
				<Dialog open={isToMarkdownOpen} onOpenChange={setIsToMarkdownOpen}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Convert to Markdown?</DialogTitle>
							<DialogDescription>
								The text, headings, pictures and buttons become Markdown, shown in {newsletter.name}&apos;s email
								template. The HTML design is replaced; the campaign this was copied from keeps it.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<DialogClose asChild>
								<Button variant="outline">Keep HTML</Button>
							</DialogClose>
							<Button onClick={convertToMarkdown} disabled={isConverting}>
								{isConverting && <Loader2 className="animate-spin" />}
								Convert
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
				<DialogDiscardCampaign
					id={campaign._id}
					subject={values.subject}
					scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
					isOpen={isDiscardOpen}
					onOpenChange={setIsDiscardOpen}
					redirectTo="/campaigns"
				/>
			</HeaderPage>

			<div className="grid gap-4 lg:grid-cols-2 lg:items-start">
				<div className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
					<Row label="From">
						<span className="flex min-w-0 items-center justify-between gap-3 text-sm">
							<span className="truncate">{from}</span>
							<Link
								href={`/newsletters/${newsletter._id}`}
								className="shrink-0 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
							>
								Product settings
							</Link>
						</span>
					</Row>
					<Row label="To">
						<span className="flex min-w-0 items-center gap-2 text-sm">
							<AvatarNewsletter newsletter={newsletter} size={18} />
							<span className="truncate">
								{newsletter.name}
								<span className="text-muted-foreground tabular-nums">
									{" "}
									· {formatNumber(audienceCount)}
								</span>
							</span>
						</span>
					</Row>
					<Row label="Subject">
						<input
							value={values.subject}
							onChange={update("subject")}
							placeholder="Subject"
							maxLength={200}
							className="h-11 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground"
						/>
					</Row>
					<Row label="Preview">
						<input
							value={values.previewText}
							onChange={update("previewText")}
							placeholder="Text shown after the subject"
							maxLength={300}
							className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						/>
					</Row>
					{archiveUrlBase && (
						<Row label="URL">
							<InputCampaignSlug
								campaignId={campaign._id}
								initialSlug={campaign.archiveSlug ?? ""}
								placeholder={slugify(values.subject, 80) || "issue"}
								urlBase={archiveUrlBase}
							/>
						</Row>
					)}
					{!isHtml && (
						<Row label="Format">
							<div role="radiogroup" aria-label="Format" className="flex h-11 items-center gap-1">
								{[
									["rich", "Editor"],
									["markdown", "Markdown"],
								].map(([value, label]) => {
									const isCurrent = format === value;
									const isDisabled = value === "markdown" && format === "rich" && !isBodyEmpty;
									return (
										<button
											key={value}
											type="button"
											role="radio"
											aria-checked={isCurrent}
											disabled={isDisabled}
											title={isDisabled ? "Empty the editor to write this draft in Markdown" : undefined}
											onClick={() => switchFormat(value)}
											className={
												isCurrent
													? "h-7 rounded-md bg-foreground px-2.5 text-xs text-background"
													: "h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
											}
										>
											{label}
										</button>
									);
								})}
							</div>
						</Row>
					)}
					{isHtml && (
						<Row label="Format">
							<div className="flex h-11 items-center justify-between gap-3">
								<span className="text-xs text-muted-foreground">HTML, sent as designed</span>
								<Button type="button" variant="outline" size="sm" onClick={() => setIsToMarkdownOpen(true)}>
									Convert to Markdown
								</Button>
							</div>
						</Row>
					)}
					{isHtml ? (
						<div className="relative">
							<span className="pointer-events-none absolute top-3 right-4 text-xs text-muted-foreground">HTML</span>
							<textarea
								value={values.body}
								onChange={update("body")}
								placeholder="<html>"
								spellCheck={false}
								aria-label="Content"
								className="block min-h-[560px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
							/>
						</div>
					) : format === "markdown" ? (
						<EditorMarkdown value={values.body} onChange={updateBody} />
					) : (
						<EditorRich key={richSeed.key} content={richSeed.html} onChange={updateBody} />
					)}
				</div>

				<div
					style={{ "--stagger": 1 }}
					className="flex flex-col gap-4 animate-enter lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)]"
				>
					<ListChecks checks={checks} />
					<PreviewEmail
						sender={newsletter}
						subject={deferredValues.subject}
						previewText={deferredValues.previewText}
						html={previewHtml}
						className="lg:min-h-0 lg:flex-1"
						toolbar={
							<span className="text-xs text-muted-foreground tabular-nums">
								{Math.ceil(rendered.bytes / 1000)} KB
							</span>
						}
					/>
				</div>
			</div>
		</>
	);
}

function StatusSave({ isSaving, error, onRetry }) {
	if (error) {
		return (
			<button
				type="button"
				onClick={onRetry}
				title={error}
				className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
			>
				<CircleAlert className="size-3.5" />
				Not saved, retry
			</button>
		);
	}
	return (
		<span aria-live="polite" className="flex min-w-16 items-center justify-end gap-1.5 text-xs text-muted-foreground">
			{isSaving ? (
				"Saving…"
			) : (
				<>
					<Check className="size-3.5" />
					Saved
				</>
			)}
		</span>
	);
}

function Row({ label, children }) {
	return (
		<div className="grid min-h-11 grid-cols-[4.5rem_minmax(0,1fr)] items-center border-b border-border/60 px-4 transition-colors duration-150 focus-within:bg-muted/40">
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}
