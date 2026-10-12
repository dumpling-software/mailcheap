"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { CircleAlert, FlaskConical, Loader2, MoreHorizontal, Pause, Play, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
	deleteAutomation,
	saveAutomation,
	sendAutomationTest,
	setAutomationStatus,
} from "@/app/(app)/automations/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import EditorMarkdown from "@/components/EditorMarkdown";
import HeaderPage from "@/components/HeaderPage";
import PreviewEmail from "@/components/PreviewEmail";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { linksOf, NODE_TYPES, validateAutomation } from "@/lib/automations/schema";
import { formatNumber } from "@/lib/format";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "@/lib/render-email";

const END = "__end";
const TYPE_LABELS = { send: "Send an email", wait: "Wait", wait_until: "Wait until", branch: "Branch", exit: "Exit" };
const NEW_NODES = {
	send: { type: "send", subject: "", markdown: "" },
	wait: { type: "wait", duration: "1d" },
	wait_until: { type: "wait_until", condition: { has_event: "event_name" }, timeout: "7d" },
	branch: { type: "branch", condition: { property: "plan", eq: "pro" } },
	exit: { type: "exit" },
};

function toDefinition(state) {
	return {
		name: state.name,
		trigger: state.trigger,
		exitWhen: state.exitWhen,
		startNodeId: state.startNodeId,
		nodes: state.nodes,
		allowReentry: state.allowReentry,
	};
}

// Nodes in the order a contact meets them from the start, then any the graph doesn't reach.
function orderNodes(nodes, startNodeId) {
	const order = [];
	const queue = [startNodeId];
	while (queue.length > 0) {
		const id = queue.shift();
		if (!nodes[id] || order.includes(id)) continue;
		order.push(id);
		queue.push(...linksOf(nodes[id]));
	}
	return [...order, ...Object.keys(nodes).filter((id) => !order.includes(id))];
}

function newNodeId(nodes, type) {
	for (let index = 1; ; index++) {
		const id = `${type.replace("_", "-")}-${index}`;
		if (!nodes[id]) return id;
	}
}

export default function FormAutomation({ automation, newsletter, counts, nodeStats, isSendingEnabled, testEmail }) {
	const [state, setState] = useState(() => toDefinition(automation));
	const [saved, setSaved] = useState(() => JSON.stringify(toDefinition(automation)));
	const [isSaving, startSaving] = useTransition();
	const [isWorking, startWorking] = useTransition();
	const problems = useMemo(() => validateAutomation(state), [state]);
	const isDirty = JSON.stringify(state) !== saved;
	const inside = counts.active + counts.waiting;
	const order = orderNodes(state.nodes, state.startNodeId);

	function update(changes) {
		setState((current) => ({ ...current, ...changes }));
	}
	function updateNode(id, node) {
		setState((current) => ({ ...current, nodes: { ...current.nodes, [id]: node } }));
	}
	function removeNode(id) {
		setState((current) => {
			const nodes = Object.fromEntries(Object.entries(current.nodes).filter(([key]) => key !== id));
			// Links to it now end the run there.
			for (const [key, node] of Object.entries(nodes)) {
				const unlinked = Object.fromEntries(Object.entries(node).filter(([, value]) => value !== id));
				if (Object.keys(unlinked).length !== Object.keys(node).length) nodes[key] = unlinked;
			}
			return { ...current, nodes, startNodeId: current.startNodeId === id ? (Object.keys(nodes)[0] ?? "start") : current.startNodeId };
		});
	}
	function addNode(type, after) {
		setState((current) => {
			const id = newNodeId(current.nodes, type);
			const nodes = { ...current.nodes, [id]: { ...NEW_NODES[type] } };
			// Added after a send or wait node: it takes that node's place in the chain.
			const previous = after && current.nodes[after];
			if (previous && ["send", "wait"].includes(previous.type)) {
				if (previous.next && ["send", "wait"].includes(type)) nodes[id].next = previous.next;
				nodes[after] = { ...previous, next: id };
			}
			return { ...current, nodes };
		});
	}

	function save() {
		startSaving(async () => {
			const result = await saveAutomation(automation._id, state);
			if (result?.error) return void toast.error(result.error);
			setSaved(JSON.stringify(state));
			toast.success(result.problems?.length ? `Saved, ${result.problems.length} thing(s) to fix before it runs` : "Saved");
		});
	}

	function setStatus(status) {
		startWorking(async () => {
			if (isDirty) {
				const result = await saveAutomation(automation._id, state);
				if (result?.error) return void toast.error(result.error);
				setSaved(JSON.stringify(state));
			}
			const result = await setAutomationStatus(automation._id, status);
			if (result?.error) toast.error(result.error);
			else toast.success(status === "active" ? "Running" : "Paused");
		});
	}

	function remove() {
		startWorking(async () => {
			const result = await deleteAutomation(automation._id);
			if (result?.error) toast.error(result.error);
		});
	}

	useEffect(() => {
		function handleKeyDown(event) {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				save();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	});

	return (
		<>
			<HeaderPage
				title={state.name || "Untitled automation"}
				backHref="/automations"
				icon={<AvatarNewsletter newsletter={newsletter} size={28} />}
				meta={<BadgeStatus status={automation.status} />}
			>
				<span className="text-xs text-muted-foreground">{isSaving ? "Saving…" : isDirty ? "Unsaved changes" : "Saved"}</span>
				<Button variant="outline" onClick={save} disabled={isSaving || !isDirty}>
					Save
				</Button>
				{automation.status === "active" ? (
					<Button variant="outline" onClick={() => setStatus("paused")} disabled={isWorking}>
						<Pause data-icon="inline-start" />
						Pause
					</Button>
				) : (
					<Button onClick={() => setStatus("active")} disabled={isWorking || problems.length > 0} title={problems[0]}>
						{isWorking ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
						{automation.status === "paused" ? "Resume" : "Activate"}
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="More" disabled={isWorking}>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem variant="destructive" onSelect={remove}>
							<Trash2 />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</HeaderPage>

			<div className="flex flex-col gap-4">
				{automation.pausedReason && automation.status === "paused" && (
					<Notice tone="red">Paused on its own: {automation.pausedReason}. Fix the cause, then resume it.</Notice>
				)}
				{inside > 0 && (
					<Notice>
						{formatNumber(inside)} contact{inside === 1 ? " is" : "s are"} in this automation. Saved changes apply to them
						from the step they&apos;re on; anyone on a step you delete leaves it.
					</Notice>
				)}
				{problems.length > 0 && (
					<Notice tone="red">
						<p className="font-medium">To fix before it can run</p>
						<ul className="mt-1 list-disc pl-4">
							{problems.slice(0, 8).map((problem) => (
								<li key={problem}>{problem}</li>
							))}
						</ul>
					</Notice>
				)}

				<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/60 shadow-border sm:grid-cols-4">
					{[
						["In it now", counts.active + counts.waiting],
						["Waiting", counts.waiting],
						["Completed", counts.completed],
						["Left early", counts.exited],
					].map(([label, value]) => (
						<div key={label} className="flex flex-col gap-1 bg-card px-4 py-3">
							<dt className="text-xs text-muted-foreground">{label}</dt>
							<dd className="text-lg font-semibold tabular-nums">{formatNumber(value)}</dd>
						</div>
					))}
				</dl>

				<Tabs defaultValue="steps">
					<TabsList>
						<TabsTrigger value="steps">Steps</TabsTrigger>
						<TabsTrigger value="json">JSON</TabsTrigger>
					</TabsList>
					<TabsContent value="steps" className="flex flex-col gap-4">
						<SettingsCard state={state} update={update} />
						{order.map((id, index) => (
							<NodeCard
								key={id}
								id={id}
								node={state.nodes[id]}
								isStart={id === state.startNodeId}
								nodeIds={order}
								stats={nodeStats[id]}
								step={index + 1}
								newsletter={newsletter}
								automationId={automation._id}
								isSendingEnabled={isSendingEnabled}
								testEmail={testEmail}
								isDirty={isDirty}
								onChange={(node) => updateNode(id, node)}
								onRemove={() => removeNode(id)}
								onAdd={(type) => addNode(type, id)}
								onMakeStart={() => update({ startNodeId: id })}
							/>
						))}
						{order.length === 0 && <ButtonAddNode onAdd={(type) => addNode(type)} />}
					</TabsContent>
					<TabsContent value="json">
						<EditorJson state={state} onApply={(definition) => setState({ ...state, ...definition })} />
					</TabsContent>
				</Tabs>
			</div>
		</>
	);
}

function Notice({ tone = "amber", children }) {
	const tones = {
		amber: "bg-amber-500/10 text-amber-900 dark:text-amber-200",
		red: "bg-red-500/10 text-red-900 dark:text-red-200",
	};
	return (
		<div className={`flex gap-3 rounded-xl p-4 text-sm text-pretty shadow-border animate-enter ${tones[tone]}`}>
			{tone === "red" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
			<div>{children}</div>
		</div>
	);
}

function Card({ title, action, children }) {
	return (
		<section className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
			<div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
				<h2 className="text-sm font-medium">{title}</h2>
				{action}
			</div>
			<div className="divide-y divide-border/60">{children}</div>
		</section>
	);
}

function Field({ label, hint, children }) {
	return (
		<label className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<span className="text-sm text-muted-foreground sm:pt-2">{label}</span>
			<span className="flex min-w-0 flex-col gap-1.5">
				{children}
				{hint && <span className="text-xs text-muted-foreground">{hint}</span>}
			</span>
		</label>
	);
}

function SettingsCard({ state, update }) {
	const { trigger } = state;
	const setTrigger = (changes) => update({ trigger: { ...trigger, ...changes } });
	return (
		<Card title="Settings">
			<Field label="Name">
				<Input value={state.name} onChange={(event) => update({ name: event.target.value })} maxLength={120} />
			</Field>
			<Field label="Starts when">
				<Select
					value={trigger.type}
					onValueChange={(type) => update({ trigger: { type, ...(trigger.condition && { condition: trigger.condition }) } })}
				>
					<SelectTrigger className="h-9 w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="contact_added">A contact joins (signup, API, app event, confirmation)</SelectItem>
						<SelectItem value="event">An event arrives from an app</SelectItem>
						<SelectItem value="property_changed">A contact property changes</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			{trigger.type === "event" && (
				<Field label="Event" hint="The name your app sends to POST /api/v1/events">
					<Input value={trigger.name ?? ""} onChange={(event) => setTrigger({ name: event.target.value.trim() })} placeholder="api_key_created" className="font-mono" />
				</Field>
			)}
			{trigger.type === "property_changed" && (
				<>
					<Field label="Property">
						<Input value={trigger.property ?? ""} onChange={(event) => setTrigger({ property: event.target.value.trim() })} placeholder="plan" className="font-mono" />
					</Field>
					<Field label="Changes to" hint="Empty: any change">
						<Input
							value={trigger.to ?? ""}
							onChange={(event) => {
								const { to: _to, ...rest } = trigger;
								update({ trigger: event.target.value ? { ...rest, to: event.target.value } : rest });
							}}
							placeholder="pro"
							className="font-mono"
						/>
					</Field>
				</>
			)}
			<Field label="Only if" hint="Optional condition on the contact (or the event's properties)">
				<InputCondition value={trigger.condition} optional onChange={(condition) => {
					const { condition: _condition, ...rest } = trigger;
					update({ trigger: condition ? { ...rest, condition } : rest });
				}} />
			</Field>
			<Field label="Leaves when" hint="Checked before every step, e.g. { &quot;has_event&quot;: &quot;first_api_call&quot; }">
				<InputCondition value={state.exitWhen} optional onChange={(exitWhen) => update({ exitWhen })} />
			</Field>
			<Field label="Again" hint="Can a contact go through it again after finishing?">
				<Switch checked={state.allowReentry} onCheckedChange={(allowReentry) => update({ allowReentry })} aria-label="Allow re-entry" />
			</Field>
		</Card>
	);
}

// Conditions as JSON (see the README): applied once the text parses.
function InputCondition({ value, onChange, optional = false }) {
	const serialized = value ? JSON.stringify(value) : "";
	const [text, setText] = useState(serialized);
	const [error, setError] = useState(null);
	// A change from elsewhere (the JSON tab) replaces the text, unless it's what's typed here.
	const [shown, setShown] = useState(serialized);
	if (shown !== serialized) {
		setShown(serialized);
		if (!sameJson(text, value)) setText(serialized);
	}
	return (
		<>
			<Textarea
				value={text}
				rows={2}
				spellCheck={false}
				placeholder={optional ? "None" : '{ "has_event": "first_api_call" }'}
				className="font-mono text-[13px]"
				onChange={(event) => {
					const next = event.target.value;
					setText(next);
					if (!next.trim() && optional) {
						setError(null);
						return onChange(null);
					}
					try {
						onChange(JSON.parse(next));
						setError(null);
					} catch {
						setError("Not valid JSON yet");
					}
				}}
			/>
			{error && <span className="text-xs text-destructive">{error}</span>}
		</>
	);
}

function sameJson(text, value) {
	try {
		return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
	} catch {
		return false;
	}
}

function SelectNode({ value, nodeIds, self, onChange, label }) {
	return (
		<Select value={value || END} onValueChange={(next) => onChange(next === END ? undefined : next)}>
			<SelectTrigger className="h-9 w-full" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={END}>End</SelectItem>
				{nodeIds
					.filter((id) => id !== self)
					.map((id) => (
						<SelectItem key={id} value={id}>
							{id}
						</SelectItem>
					))}
			</SelectContent>
		</Select>
	);
}

function ButtonAddNode({ onAdd, label = "Add a step" }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm">
					<Plus data-icon="inline-start" />
					{label}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				{NODE_TYPES.map((type) => (
					<DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
						{TYPE_LABELS[type]}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function NodeCard({ id, node, isStart, nodeIds, stats, step, onChange, onRemove, onAdd, onMakeStart, ...sendProps }) {
	const set = (changes) => onChange({ ...node, ...changes });
	const link = (key) => (
		<SelectNode value={node[key]} nodeIds={nodeIds} self={id} label={key} onChange={(target) => {
			const { [key]: _old, ...rest } = node;
			onChange(target ? { ...rest, [key]: target } : rest);
		}} />
	);
	return (
		<Card
			title={
				<span className="flex items-center gap-2">
					<span className="text-muted-foreground tabular-nums">{step}.</span>
					{TYPE_LABELS[node.type] ?? node.type}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{id}</code>
					{isStart && <BadgeStatus status="active" label="Start" />}
				</span>
			}
			action={
				<span className="flex items-center gap-1">
					<ButtonAddNode onAdd={onAdd} label="After" />
					{!isStart && (
						<Button variant="ghost" size="sm" onClick={onMakeStart}>
							Start here
						</Button>
					)}
					<Button variant="ghost" size="icon" aria-label={`Delete ${id}`} onClick={onRemove}>
						<Trash2 />
					</Button>
				</span>
			}
		>
			{node.type === "send" && <NodeSend id={id} node={node} set={set} stats={stats} {...sendProps} />}
			{node.type === "send" && <Field label="Then">{link("next")}</Field>}
			{node.type === "wait" && (
				<>
					<Field label="For" hint="30m, 12h, 4d or 2w">
						<Input value={node.duration ?? ""} onChange={(event) => set({ duration: event.target.value.trim() })} className="w-32 font-mono" />
					</Field>
					<Field label="Then">{link("next")}</Field>
				</>
			)}
			{node.type === "wait_until" && (
				<>
					<Field label="Until" hint="Checked when the contact's events or properties change, and at the timeout">
						<InputCondition value={node.condition} onChange={(condition) => set({ condition })} />
					</Field>
					<Field label="At most" hint="30m, 12h, 4d or 2w">
						<Input value={node.timeout ?? ""} onChange={(event) => set({ timeout: event.target.value.trim() })} className="w-32 font-mono" />
					</Field>
					<Field label="When it holds">{link("met")}</Field>
					<Field label="After the timeout">{link("timeout_next")}</Field>
				</>
			)}
			{node.type === "branch" && (
				<>
					<Field label="If">
						<InputCondition value={node.condition} onChange={(condition) => set({ condition })} />
					</Field>
					<Field label="Yes">{link("yes")}</Field>
					<Field label="No">{link("no")}</Field>
				</>
			)}
			{node.type === "exit" && <p className="px-4 py-3 text-sm text-muted-foreground">The run ends here.</p>}
		</Card>
	);
}

function NodeSend({ id, node, set, stats, newsletter, automationId, isSendingEnabled, testEmail, isDirty }) {
	const [isTesting, startTesting] = useTransition();
	const isMarkdown = Boolean(node.markdown?.trim()) || !node.html;
	const deferred = useDeferredValue(node);
	const previewHtml = useMemo(() => {
		const rendered = renderEmail({
			format: isMarkdown ? "markdown" : "html",
			markdown: deferred.markdown ?? "",
			html: deferred.html ?? "",
			subject: deferred.subject,
			previewText: deferred.previewText,
			newsletter,
		});
		return withResponsiveImages(rendered.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"));
	}, [deferred, isMarkdown, newsletter]);

	function sendTest() {
		startTesting(async () => {
			if (isDirty) return void toast.error("Save first: the test sends the saved email");
			const result = await sendAutomationTest(automationId, id);
			if (result?.error) toast.error(result.error);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	return (
		<>
			<Field label="Subject">
				<Input value={node.subject ?? ""} onChange={(event) => set({ subject: event.target.value })} maxLength={200} />
			</Field>
			<Field label="Preview text">
				<Input value={node.previewText ?? ""} onChange={(event) => set({ previewText: event.target.value })} maxLength={300} />
			</Field>
			<div className="grid lg:grid-cols-2">
				<div className="border-border/60 lg:border-r">
					{isMarkdown ? (
						<EditorMarkdown value={node.markdown ?? ""} onChange={(markdown) => set({ markdown })} minHeight={320} />
					) : (
						<div className="flex flex-col gap-2 p-4 text-sm">
							<p className="text-muted-foreground">
								Imported HTML. Edit it here, or switch to Markdown{node.markdownDraft ? " (a converted draft is ready)" : ""}.
							</p>
							<Textarea
								value={node.html ?? ""}
								onChange={(event) => set({ html: event.target.value })}
								spellCheck={false}
								className="h-80 font-mono text-[12px] [field-sizing:fixed]"
							/>
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								onClick={() => set({ markdown: node.markdownDraft || "Write the email in Markdown." })}
							>
								Use Markdown
							</Button>
						</div>
					)}
				</div>
				<div className="flex flex-col gap-2 p-3">
					<PreviewEmail
						sender={newsletter}
						subject={deferred.subject}
						previewText={deferred.previewText}
						html={previewHtml}
						fit="content"
						toolbar={
							<Button variant="ghost" size="sm" onClick={sendTest} disabled={!isSendingEnabled || isTesting}>
								{isTesting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FlaskConical data-icon="inline-start" />}
								Test
							</Button>
						}
					/>
					{stats && <NodeStats stats={stats} />}
				</div>
			</div>
		</>
	);
}

function NodeStats({ stats }) {
	const rate = (count) => (stats.sent ? ` · ${Math.round((count / stats.sent) * 1000) / 10}%` : "");
	const items = [
		["Sent", stats.sent, ""],
		["Delivered", stats.delivered, rate(stats.delivered)],
		["Clicked", stats.clicked, rate(stats.clicked)],
		["Opened", stats.opened, `${rate(stats.opened)} (unreliable)`],
		["Bounced", stats.bounced, rate(stats.bounced)],
		["Complaints", stats.complained, rate(stats.complained)],
		["Unsubscribed", stats.unsubscribed, rate(stats.unsubscribed)],
	];
	return (
		<dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-4">
			{items.map(([label, value, suffix]) => (
				<div key={label} className="flex flex-col">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="font-medium tabular-nums">
						{formatNumber(value)}
						<span className="font-normal text-muted-foreground">{suffix}</span>
					</dd>
				</div>
			))}
		</dl>
	);
}

// The whole definition as JSON, for bigger edits and copying automations between newsletters.
function EditorJson({ state, onApply }) {
	const definition = JSON.stringify(
		{ trigger: state.trigger, exitWhen: state.exitWhen, startNodeId: state.startNodeId, allowReentry: state.allowReentry, nodes: state.nodes },
		null,
		2
	);
	const [text, setText] = useState(definition);
	const [errors, setErrors] = useState([]);
	// Edits in the Steps tab show here: the text follows the definition whenever that changes.
	const [shown, setShown] = useState(definition);
	if (shown !== definition) {
		setShown(definition);
		setText(definition);
	}

	function apply() {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			return setErrors([`Not valid JSON: ${error.message}`]);
		}
		const problems = validateAutomation(parsed);
		setErrors(problems);
		onApply({
			trigger: parsed.trigger,
			exitWhen: parsed.exitWhen ?? null,
			startNodeId: parsed.startNodeId ?? "start",
			allowReentry: parsed.allowReentry === true,
			nodes: parsed.nodes ?? {},
		});
		toast.success(problems.length ? "Applied, with problems to fix" : "Applied: save to keep it");
	}

	return (
		<Card title="Definition" action={<Button size="sm" variant="outline" onClick={apply}>Apply</Button>}>
			<textarea
				value={text}
				onChange={(event) => setText(event.target.value)}
				spellCheck={false}
				aria-label="Automation JSON"
				className="block min-h-[560px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content]"
			/>
			{errors.length > 0 && (
				<ul className="list-disc px-8 py-3 text-sm text-destructive">
					{errors.map((error) => (
						<li key={error}>{error}</li>
					))}
				</ul>
			)}
		</Card>
	);
}
