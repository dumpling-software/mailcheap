import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { sendAlert } from "@/lib/alerts";
import { matchesTrigger, advance, afterSend } from "@/lib/automations/step";
import { isSendingEnabled } from "@/lib/config";
import { automations, contactEvents, contacts, enrollments, getDb, messages, newsletters, query } from "@/lib/db";
import { sendAutomationEmail } from "@/lib/sending";
import { getRatesPauseReason } from "@/lib/sending-rules";

const LIVE_STATUSES = ["active", "waiting"];
// How long a job holds a run it's moving; a crashed job's runs come back after it.
const LOCK_MS = 10 * 60_000;
// Sending off or throttled: the run stays at its send node and tries again.
const RETRY_MS = 15 * 60_000;
// A paused or draft automation holds its runs where they are, and looks again later.
const HOLD_MS = 60 * 60_000;
const CONTEXT_ROWS = 500;
// Health is judged on the latest emails once there are enough of them, like campaigns.
const HEALTH_WINDOW = 500;
const MIN_SENT_FOR_HEALTH = 100;

function findAutomation(id) {
	return getDb()
		.select()
		.from(automations)
		.where(eq(automations._id, id))
		.then(([row]) => row ?? null);
}

// What conditions read about a contact: their events and their opens and clicks.
export async function loadContext({ automation, contact, triggerEvent, now = new Date() }) {
	if (!contact) return { contact: null, events: [], engagement: [], event: triggerEvent ?? null, automationId: automation._id, now };
	const db = getDb();
	const [eventRows, engagement] = await Promise.all([
		db
			.select({ name: contactEvents.name, occurredAt: contactEvents.occurredAt, properties: contactEvents.properties })
			.from(contactEvents)
			.where(eq(contactEvents.contactId, contact._id))
			.orderBy(desc(contactEvents.occurredAt))
			.limit(CONTEXT_ROWS),
		db
			.select({
				automationId: messages.automationId,
				nodeId: messages.nodeId,
				campaignId: messages.campaignId,
				openedAt: messages.openedAt,
				clickedAt: messages.clickedAt,
			})
			.from(messages)
			.where(and(eq(messages.contactId, contact._id), or(isNotNull(messages.openedAt), isNotNull(messages.clickedAt))))
			.orderBy(desc(messages.createdAt))
			.limit(CONTEXT_ROWS),
	]);
	return { contact, events: eventRows, engagement, event: triggerEvent ?? null, automationId: automation._id, now };
}

// Starts a run, unless the contact is in this automation already, or went through it and it doesn't
// take people twice. The advisory lock makes two triggers at once start one run.
export async function enroll({ automation, contact, triggerEvent = null, now = new Date() }) {
	return getDb().transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${automation._id}:${contact._id}`}, 0))`);
		const previous = await tx
			.select({ status: enrollments.status })
			.from(enrollments)
			.where(and(eq(enrollments.automationId, automation._id), eq(enrollments.contactId, contact._id)));
		if (previous.some(({ status }) => LIVE_STATUSES.includes(status))) return null;
		if (previous.length > 0 && !automation.allowReentry) return null;
		const [enrollment] = await tx
			.insert(enrollments)
			.values({
				automationId: automation._id,
				contactId: contact._id,
				status: "active",
				currentNodeId: automation.startNodeId,
				nextRunAt: now,
				triggerEvent: triggerEvent ? { name: triggerEvent.name, properties: triggerEvent.properties ?? {} } : null,
			})
			.returning();
		return enrollment;
	});
}

// Takes the run for this job: only one job or incoming event moves a run at a time. due: only when its
// time came (the scheduled job); otherwise any live run (an event waking it).
async function claim(enrollmentId, { now, due }) {
	const [enrollment] = await getDb()
		.update(enrollments)
		.set({ lockedUntil: new Date(now.getTime() + LOCK_MS) })
		.where(
			and(
				eq(enrollments._id, enrollmentId),
				inArray(enrollments.status, LIVE_STATUSES),
				or(isNull(enrollments.lockedUntil), lt(enrollments.lockedUntil, now)),
				due ? lte(enrollments.nextRunAt, now) : undefined
			)
		)
		.returning();
	return enrollment ?? null;
}

async function save(enrollment, changes, visited) {
	await getDb()
		.update(enrollments)
		.set({
			...changes,
			lockedUntil: null,
			...(visited.length > 0 && { history: sql`${enrollments.history} || ${JSON.stringify(visited)}::jsonb` }),
		})
		.where(eq(enrollments._id, enrollment._id));
}

// Moves one run as far as it goes now: through branches and sends, until a wait or the end.
export async function processEnrollment(enrollmentId, { now = new Date(), due = false } = {}) {
	const enrollment = await claim(enrollmentId, { now, due });
	if (!enrollment) return { skipped: true };
	const db = getDb();
	const automation = await findAutomation(enrollment.automationId);
	if (automation?.status !== "active") {
		await save(enrollment, { nextRunAt: new Date(now.getTime() + HOLD_MS) }, []);
		return { held: true };
	}
	const [[contact], [newsletter]] = await Promise.all([
		db.select().from(contacts).where(eq(contacts._id, enrollment.contactId)),
		db.select().from(newsletters).where(eq(newsletters._id, automation.newsletterId)),
	]);
	const context = await loadContext({ automation, contact, triggerEvent: enrollment.triggerEvent, now });

	let state = { currentNodeId: enrollment.currentNodeId, waitFor: enrollment.waitFor };
	const visited = [];
	let sent = 0;
	for (;;) {
		const { effect, state: next } = advance({ automation, enrollment: state, context, now });
		visited.push(...next.visited);
		state = { currentNodeId: next.currentNodeId, waitFor: next.waitFor };

		if (effect.type === "send") {
			const result = isSendingEnabled()
				? await sendAutomationEmail({ automation, enrollment, nodeId: effect.nodeId, contact, newsletter })
				: { status: "retry" };
			if (result.status === "retry") {
				await save(enrollment, { status: "active", ...state, nextRunAt: new Date(now.getTime() + RETRY_MS) }, visited);
				return { sent, retry: true };
			}
			if (result.status === "sent") sent++;
			const moved = afterSend({ state: { visited: [] }, nodeId: effect.nodeId, next: effect.next, now });
			visited.push(...moved.visited.map((entry) => ({ ...entry, outcome: result.status })));
			state = { currentNodeId: moved.currentNodeId, waitFor: null };
			// The send refused a contact who left: re-read them so the next step sees it and exits.
			if (result.status === "suppressed") {
				const [fresh] = await db.select().from(contacts).where(eq(contacts._id, enrollment.contactId));
				context.contact = fresh ?? null;
			}
			continue;
		}

		if (effect.type === "wait") {
			await save(enrollment, { status: "waiting", ...state, nextRunAt: effect.until }, visited);
			return { sent, waiting: effect.until };
		}
		const isComplete = effect.type === "complete";
		await save(
			enrollment,
			{
				status: isComplete ? "completed" : "exited",
				...state,
				nextRunAt: null,
				finishedAt: now,
				...(!isComplete && { exitReason: effect.reason }),
			},
			visited
		);
		return { sent, [isComplete ? "completed" : "exited"]: true, ...(effect.reason && { reason: effect.reason }) };
	}
}

// The scheduled job: every run whose time came, oldest first, until the batch or the time is up.
export async function runDue({ limit = 200, now = new Date(), deadline = Infinity } = {}) {
	const due = await getDb()
		.select({ _id: enrollments._id })
		.from(enrollments)
		.where(
			and(
				inArray(enrollments.status, LIVE_STATUSES),
				lte(enrollments.nextRunAt, now),
				or(isNull(enrollments.lockedUntil), lt(enrollments.lockedUntil, now))
			)
		)
		.orderBy(asc(enrollments.nextRunAt))
		.limit(limit);
	const totals = { processed: 0, sent: 0, failed: 0, more: due.length === limit };
	for (const { _id } of due) {
		if (Date.now() > deadline) {
			totals.more = true;
			break;
		}
		try {
			const result = await processEnrollment(_id, { now: new Date(Math.max(now.getTime(), Date.now())), due: true });
			if (!result.skipped) totals.processed++;
			totals.sent += result.sent ?? 0;
		} catch (error) {
			totals.failed++;
			console.error(`[automations] Run ${_id} failed:`, error);
			// Unlocked a little later, so one broken run doesn't block the job every time.
			await getDb()
				.update(enrollments)
				.set({ lockedUntil: null, nextRunAt: new Date(Date.now() + RETRY_MS) })
				.where(eq(enrollments._id, _id))
				.catch(() => {});
		}
	}
	return totals;
}

// Starts the newsletter's active automations whose trigger matches, and moves each new run right away.
export async function startAutomations({ newsletter, contact, type, eventName, event, changes = [], now = new Date() }) {
	if (contact?.status !== "active") return [];
	const candidates = await getDb()
		.select()
		.from(automations)
		.where(
			and(
				eq(automations.newsletterId, newsletter._id),
				eq(automations.status, "active"),
				sql`${automations.trigger}->>'type' = ${type}`
			)
		);
	const started = [];
	for (const automation of candidates) {
		const context = await loadContext({ automation, contact, triggerEvent: event, now });
		if (!matchesTrigger(automation.trigger, { type, eventName, changes, context })) continue;
		const enrollment = await enroll({ automation, contact, triggerEvent: event, now });
		if (!enrollment) continue;
		started.push(enrollment._id);
		await processEnrollment(enrollment._id, { now });
	}
	return started;
}

// Something about the contact changed (an event, a property): runs waiting on them look again now.
export async function wakeContact(contactId, { now = new Date() } = {}) {
	const waiting = await getDb()
		.select({ _id: enrollments._id })
		.from(enrollments)
		.where(and(eq(enrollments.contactId, contactId), eq(enrollments.status, "waiting")));
	for (const { _id } of waiting) await processEnrollment(_id, { now });
	return waiting.length;
}

// Like campaigns, an automation stops itself when its latest emails bounce or draw complaints too often.
// Only emails since it last became active count: resuming starts the window again.
export async function checkAutomationHealth(automationId) {
	const [row] = await query(sql`
		select count(*)::int as sent,
			count(bounced_at)::int as bounced,
			count(complained_at)::int as complained
		from (select m.bounced_at, m.complained_at from messages m
			join automations a on a.id = m.automation_id
			where m.automation_id = ${automationId} and m.sent_at is not null
				and m.sent_at >= coalesce(a.activated_at, '-infinity'::timestamptz)
			order by m.sent_at desc limit ${HEALTH_WINDOW}) recent`);
	if (!row || row.sent < MIN_SENT_FOR_HEALTH) return null;
	const reason = getRatesPauseReason(row);
	if (!reason) return null;
	const paused = await getDb()
		.update(automations)
		.set({ status: "paused", pausedReason: `${reason} is over the limit` })
		.where(and(eq(automations._id, automationId), eq(automations.status, "active")))
		.returning({ name: automations.name });
	if (paused.length > 0) {
		await sendAlert({
			key: `automation-paused-${automationId}`,
			title: "Automation paused",
			detail: `"${paused[0].name}": ${reason} is over the limit over its last ${row.sent} emails. Its contacts wait where they are until you resume it.`,
			path: `/automations/${automationId}`,
			cooldownMinutes: 1,
		});
	}
	return reason;
}

