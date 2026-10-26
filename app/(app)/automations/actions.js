"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { notifyActivity } from "@/lib/alerts";
import { requireSession } from "@/lib/auth";
import { getEnrollmentCounts } from "@/lib/automations/queries";
import { AUTOMATION_STATUSES, validateAutomation } from "@/lib/automations/schema";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { automations, enrollments, getDb } from "@/lib/db";
import { findNewsletter } from "@/lib/records";
import { getAutomationContent, sendAutomationTestEmail } from "@/lib/sending";
import { getSendProblem } from "@/lib/sending-rules";
import { isPlainObject, isUuid } from "@/lib/validation";

const MAX_NAME_LENGTH = 120;

async function findAutomation(id) {
	await requireSession();
	if (!isUuid(String(id ?? ""))) return null;
	const [automation] = await getDb().select().from(automations).where(eq(automations._id, id));
	return automation ?? null;
}

function revalidate(id) {
	revalidatePath("/automations");
	if (id) revalidatePath(`/automations/${id}`);
}

export async function createAutomation(newsletterId) {
	await requireSession();
	if (!(await findNewsletter(newsletterId))) return { error: "Newsletter not found" };
	const [automation] = await getDb()
		.insert(automations)
		.values({
			newsletterId,
			name: "Untitled automation",
			trigger: { type: "contact_added" },
			nodes: { start: { type: "send", subject: "", markdown: "" } },
		})
		.returning({ _id: automations._id });
	revalidate();
	redirect(`/automations/${automation._id}`);
}

function readDefinition(values) {
	if (!isPlainObject(values)) return { error: "Nothing to save" };
	const name = String(values.name ?? "").trim().slice(0, MAX_NAME_LENGTH);
	if (!name) return { error: "Name the automation" };
	const definition = {
		name,
		trigger: values.trigger,
		exitWhen: isPlainObject(values.exitWhen) ? values.exitWhen : null,
		startNodeId: typeof values.startNodeId === "string" && values.startNodeId ? values.startNodeId : "start",
		nodes: values.nodes,
		allowReentry: values.allowReentry === true,
	};
	if (!isPlainObject(definition.trigger) || !isPlainObject(definition.nodes)) return { error: "The trigger and the nodes are required" };
	return { definition };
}

// Drafts and paused automations save whatever is there and list what's left to fix; an active one only
// saves a definition that can run. Contacts in it keep their place; one on a deleted node leaves.
export async function saveAutomation(id, values) {
	const automation = await findAutomation(id);
	if (!automation) return { error: "Automation not found" };
	const { definition, error } = readDefinition(values);
	if (error) return { error };
	const problems = validateAutomation(definition);
	if (automation.status === "active" && problems.length > 0) {
		return { error: `Can't save while it runs: ${problems[0]}`, problems };
	}
	await getDb().update(automations).set(definition).where(eq(automations._id, automation._id));
	revalidate(automation._id);
	return { ok: true, problems };
}

// Every email has to pass the campaign checks (subject, content, size, unsubscribe link) before it runs.
function getEmailProblems(automation, newsletter) {
	return Object.entries(automation.nodes ?? {})
		.filter(([, node]) => node.type === "send")
		.map(([nodeId, node]) => {
			const problem = getSendProblem({ campaign: { ...getAutomationContent(node), _id: automation._id }, newsletter });
			return problem && `${nodeId}: ${problem}`;
		})
		.filter(Boolean);
}

export async function setAutomationStatus(id, status) {
	const automation = await findAutomation(id);
	if (!automation) return { error: "Automation not found" };
	if (!AUTOMATION_STATUSES.includes(status)) return { error: "Invalid status" };
	if (status === "active") {
		const problems = validateAutomation(automation);
		if (problems.length > 0) return { error: problems[0], problems };
		const newsletter = await findNewsletter(automation.newsletterId);
		const emailProblems = getEmailProblems(automation, newsletter);
		if (emailProblems.length > 0) return { error: emailProblems[0], problems: emailProblems };
	}
	await getDb()
		.update(automations)
		.set({ status, ...(status === "active" && { pausedReason: null, activatedAt: new Date() }) })
		.where(eq(automations._id, automation._id));
	await notifyActivity([`Automation ${status === "active" ? "activated" : status}: ${automation.name}`, `${getAppUrl()}/automations/${automation._id}`]);
	revalidate(automation._id);
	return { ok: true };
}

export async function sendAutomationTest(id, nodeId) {
	const automation = await findAutomation(id);
	if (!automation) return { error: "Automation not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	try {
		await sendAutomationTestEmail({ automationId: automation._id, nodeId, to: process.env.ADMIN_EMAIL });
		return { ok: true };
	} catch (error) {
		console.error("[automations] Test failed:", error);
		return { error: error.message || "Sending failed" };
	}
}

// Only an automation nobody went through can be deleted; the others keep their history, paused.
export async function deleteAutomation(id) {
	const automation = await findAutomation(id);
	if (!automation) return { error: "Automation not found" };
	const counts = await getEnrollmentCounts(automation._id);
	if (Object.values(counts).some((count) => count > 0)) return { error: "Contacts went through it: pause it instead" };
	const db = getDb();
	await db.delete(enrollments).where(eq(enrollments.automationId, automation._id));
	await db.delete(automations).where(eq(automations._id, automation._id));
	revalidate();
	redirect("/automations");
}
