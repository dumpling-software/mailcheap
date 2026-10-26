"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteEmailRule, saveEmailRule, testEmail } from "@/app/(app)/email-checks/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SOURCES = {
	rule: "a rule on this page",
	list: "the disposable domain lists",
	verifymail: "verifymail.io",
	debounce: "DeBounce",
	dns: "the domain's DNS",
	unchecked: "nothing: the lookups didn't answer, so it's let through",
};

export function FormEmailRule() {
	const [state, action, isPending] = useActionState(saveEmailRule, null);
	const [ruleAction, setRuleAction] = useState("block");
	const form = useRef(null);

	useEffect(() => {
		if (state?.error) toast.error(state.error);
		if (state?.ok) {
			toast.success(`Saved ${state.saved}`);
			form.current?.reset();
		}
	}, [state]);

	return (
		<form ref={form} action={action} className="flex flex-col gap-2 sm:flex-row">
			<Input name="value" placeholder="example.com or jane@example.com" required className="sm:flex-1" />
			<input type="hidden" name="action" value={ruleAction} />
			<Select value={ruleAction} onValueChange={setRuleAction}>
				<SelectTrigger className="sm:w-28">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="block">Block</SelectItem>
					<SelectItem value="allow">Allow</SelectItem>
				</SelectContent>
			</Select>
			<Input name="note" placeholder="Note (optional)" className="sm:w-56" />
			<Button type="submit" disabled={isPending}>
				{isPending ? <Loader2 className="animate-spin" /> : "Add"}
			</Button>
		</form>
	);
}

export function FormTestEmail() {
	const [state, action, isPending] = useActionState(testEmail, null);

	return (
		<div className="flex flex-col gap-3">
			<form action={action} className="flex flex-col gap-2 sm:flex-row">
				<Input name="email" type="text" placeholder="jane@example.com" required className="sm:flex-1" />
				<Button type="submit" variant="secondary" disabled={isPending}>
					{isPending ? <Loader2 className="animate-spin" /> : "Check"}
				</Button>
			</form>
			{state && (
				<div className="rounded-lg bg-muted px-3 py-2 text-sm">
					<p className={state.accepted ? "text-foreground" : "text-destructive"}>
						{state.accepted ? "Accepted." : `Refused: ${state.message}`}
					</p>
					{state.source && <p className="text-muted-foreground">Decided by {SOURCES[state.source] ?? state.source}.</p>}
				</div>
			)}
		</div>
	);
}

export function ButtonDeleteEmailRule({ id, value }) {
	const [isPending, startTransition] = useTransition();

	function remove() {
		startTransition(async () => {
			const result = await deleteEmailRule(id);
			if (result?.error) toast.error(result.error);
			else toast.success(`Removed ${value}`);
		});
	}

	return (
		<Button variant="ghost" size="sm" onClick={remove} disabled={isPending} className="text-muted-foreground hover:text-destructive">
			{isPending ? <Loader2 className="animate-spin" /> : "Remove"}
		</Button>
	);
}
