import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, isNotNull, lt, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	appointments,
	contacts,
	meetingActionItems,
	meetingFollowups,
	notes,
	organizations,
	organizerDocuments,
	recordingOutputs,
	recordingSegments,
	recordings,
	taskLinks,
	tasks,
	users,
} from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import { chatCompletion } from '@/lib/ai/openai';
import { getOrCreateBookingProfile } from '@/lib/booking/profile';
import { publicBookingUrl, eventTypeUrl } from '@/lib/booking/links';

// ---------------------------------------------------------------------------
// Tunables. The on/off switch and grace period are per-org settings (see
// lib/meetings/settings.ts + the /settings card) — read in SQL below. The
// values here bound cron work and recording auto-adoption.
// ---------------------------------------------------------------------------

/**
 * On first deploy, don't sweep the entire calendar history into the loop —
 * only meetings that ended within this window become follow-ups.
 */
const BACKFILL_LOOKBACK_HOURS = 72;
/** Auto-adopt a recording started this many minutes before / after the meeting. */
const ADOPT_BEFORE_MIN = 120;
const ADOPT_AFTER_MIN = 240;
/** Bound the work any single cron tick does, per step. */
const MAX_PER_TICK = 50;

type NotesSource = 'recorder' | 'recall' | 'manual';

export interface FollowupTickResult {
	backfilled: number;
	notesLinked: number;
	chased: number;
	debriefsCreated: number;
	completed: number;
	errors: number;
}

const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** A bot-source recording is a Recall capture; everything else is the device recorder. */
function sourceOfRecording(recSource: string | null): NotesSource {
	return recSource && recSource.endsWith('_bot') ? 'recall' : 'recorder';
}

/**
 * Advance every in-scope meeting one step along the follow-up lifecycle. Safe
 * to call repeatedly (the cron does, every 15 min) and idempotent: each step
 * is gated on state + the presence of the artifact it would create, so a
 * re-run never double-creates a task or re-executes an action item.
 *
 * Step order matters — detect-notes runs before chase so a meeting whose notes
 * already landed never gets a "get the notes" nag.
 */
export async function runMeetingFollowups(): Promise<FollowupTickResult> {
	const result: FollowupTickResult = {
		backfilled: 0, notesLinked: 0, chased: 0, debriefsCreated: 0, completed: 0, errors: 0,
	};

	result.backfilled = await backfillFollowups(result);
	result.notesLinked = await detectNotes(result);
	result.chased = await createChaseTasks(result);
	result.debriefsCreated = await createDebriefs(result);
	result.completed = await executeApproved(result);

	logger.info({ ...result }, 'meeting-followups tick complete');
	return result;
}

// --- Step A: backfill -------------------------------------------------------

async function backfillFollowups(result: FollowupTickResult): Promise<number> {
	const now = new Date().toISOString();
	const candidates = await db
		.select({
			id: appointments.id,
			userId: appointments.userId,
			organizationId: appointments.organizationId,
			endsAt: appointments.endsAt,
		})
		.from(appointments)
		.innerJoin(organizations, eq(organizations.id, appointments.organizationId))
		.leftJoin(meetingFollowups, eq(meetingFollowups.appointmentId, appointments.id))
		.where(and(
			eq(organizations.meetingFollowupsEnabled, true),
			isNotNull(appointments.contactId),
			isNotNull(appointments.endsAt),
			lt(appointments.endsAt, now),
			gte(appointments.endsAt, minsAgo(BACKFILL_LOOKBACK_HOURS * 60)),
			isNull(meetingFollowups.id),
		))
		.limit(MAX_PER_TICK);

	let n = 0;
	for (const c of candidates) {
		try {
			await db.insert(meetingFollowups).values({
				id: randomUUID(),
				organizationId: c.organizationId,
				userId: c.userId,
				appointmentId: c.id,
				state: 'awaiting_notes',
				meetingEndedAt: c.endsAt as string,
			}).onConflictDoNothing({ target: meetingFollowups.appointmentId });
			n += 1;
		} catch (err) {
			result.errors += 1;
			logger.warn({ appointmentId: c.id, err: msg(err) }, 'followup backfill failed');
		}
	}
	return n;
}

// --- Step B: detect notes ---------------------------------------------------

async function detectNotes(result: FollowupTickResult): Promise<number> {
	const rows = await loadFollowups(['awaiting_notes', 'chasing_notes']);
	let n = 0;
	for (const r of rows) {
		try {
			const found = await findNotesForMeeting(r);
			if (!found) continue;

			// Auto-complete the chase task — the notes the AI asked for arrived.
			if (r.chaseTaskId) await markTaskDone(r.chaseTaskId);

			await db.update(meetingFollowups).set({
				state: 'notes_received',
				notesSource: found.source,
				recordingId: found.recordingId ?? null,
				notesReceivedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}).where(eq(meetingFollowups.id, r.followupId));
			n += 1;
		} catch (err) {
			result.errors += 1;
			logger.warn({ followupId: r.followupId, err: msg(err) }, 'detectNotes failed');
		}
	}
	return n;
}

interface FoundNotes { source: NotesSource; recordingId: string | null }

async function findNotesForMeeting(r: FollowupRow): Promise<FoundNotes | null> {
	// 1. A recording already linked to this meeting and finished transcribing.
	const [linkedRec] = await db
		.select({ id: recordings.id, source: recordings.source })
		.from(recordings)
		.where(and(eq(recordings.appointmentId, r.appointmentId), eq(recordings.status, 'ready')))
		.limit(1);
	if (linkedRec) return { source: sourceOfRecording(linkedRec.source), recordingId: linkedRec.id };

	// 2. Auto-adopt: a ready recording for the same contact, no meeting yet, in
	//    the meeting's time window. Lets the recorder "just work" without the
	//    UI having to pass an appointmentId. Closest start wins.
	if (r.contactId) {
		const winStart = new Date(new Date(r.startsAt).getTime() - ADOPT_BEFORE_MIN * 60_000).toISOString();
		const winEnd = new Date(new Date(r.meetingEndedAt).getTime() + ADOPT_AFTER_MIN * 60_000).toISOString();
		const [adopt] = await db
			.select({ id: recordings.id, source: recordings.source })
			.from(recordings)
			.where(and(
				eq(recordings.organizationId, r.organizationId),
				eq(recordings.contactId, r.contactId),
				eq(recordings.status, 'ready'),
				isNull(recordings.appointmentId),
				isNotNull(recordings.startedAt),
				gte(recordings.startedAt, winStart),
				lt(recordings.startedAt, winEnd),
			))
			.orderBy(desc(recordings.startedAt))
			.limit(1);
		if (adopt) {
			await db.update(recordings)
				.set({ appointmentId: r.appointmentId, updatedAt: new Date().toISOString() })
				.where(and(eq(recordings.id, adopt.id), isNull(recordings.appointmentId)));
			return { source: sourceOfRecording(adopt.source), recordingId: adopt.id };
		}
	}

	// 3. A note the user (or AI) attached to this meeting.
	const [note] = await db
		.select({ id: notes.id })
		.from(notes)
		.where(eq(notes.appointmentId, r.appointmentId))
		.limit(1);
	if (note) return { source: 'manual', recordingId: null };

	return null;
}

// --- Step C: chase ----------------------------------------------------------

async function createChaseTasks(result: FollowupTickResult): Promise<number> {
	// The grace check runs in SQL against each org's configured grace period:
	// `meeting_ended_at < now() - grace_minutes`. Doing it in Postgres (rather
	// than a JS string compare) also dodges the `2026-05-29 14:00:00+00` shape
	// timestamptz can return in string mode, which doesn't compare lexically.
	const rows = await loadFollowups(
		['awaiting_notes'],
		and(
			eq(organizations.meetingFollowupsEnabled, true),
			sql`${meetingFollowups.meetingEndedAt} < now() - (${organizations.meetingFollowupsGraceMinutes} * interval '1 minute')`,
		),
	);
	let n = 0;
	for (const r of rows) {
		try {
			if (r.chaseTaskId) continue;

			const who = await contactName(r.contactId);
			const taskId = await createOrganizerTask({
				userId: r.userId,
				organizationId: r.organizationId,
				title: truncate(`Get the notes — ${r.title}`, 200),
				description:
					`Your meeting "${r.title}"${who ? ` with ${who}` : ''} has ended and no notes have come in yet.\n\n` +
					`Add a note to this meeting, or record/upload the call, and RocketSuite will pull together what happened and the follow-ups.`,
				reviewRequired: false,
				assignedContactIds: r.contactId ? [r.contactId] : [],
			});
			await linkTaskToAppointment(r.organizationId, taskId, r.appointmentId);

			await db.update(meetingFollowups).set({
				state: 'chasing_notes', chaseTaskId: taskId, updatedAt: new Date().toISOString(),
			}).where(eq(meetingFollowups.id, r.followupId));
			n += 1;
		} catch (err) {
			result.errors += 1;
			logger.warn({ followupId: r.followupId, err: msg(err) }, 'createChaseTask failed');
		}
	}
	return n;
}

// --- Step D: review → Call Debrief ------------------------------------------

async function createDebriefs(result: FollowupTickResult): Promise<number> {
	const rows = await loadFollowups(['notes_received']);
	let n = 0;
	for (const r of rows) {
		try {
			if (r.debriefTaskId) continue;

			const items = r.recordingId ? await extractActionItems(r) : [];
			const who = await contactName(r.contactId);
			const summary = r.recordingId ? await recordingSummary(r.recordingId) : null;

			const taskId = await createOrganizerTask({
				userId: r.userId,
				organizationId: r.organizationId,
				title: truncate(`Call Debrief — ${r.title}`, 200),
				description: buildDebriefDescription({ title: r.title, who, summary, items, hasRecording: !!r.recordingId }),
				reviewRequired: true,
				assignedContactIds: r.contactId ? [r.contactId] : [],
				entityType: 'meeting_debrief',
				entityId: r.appointmentId,
			});
			await linkTaskToAppointment(r.organizationId, taskId, r.appointmentId);

			await db.update(meetingFollowups).set({
				state: 'debrief_pending', debriefTaskId: taskId,
				debriefedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			}).where(eq(meetingFollowups.id, r.followupId));
			n += 1;
		} catch (err) {
			result.errors += 1;
			logger.warn({ followupId: r.followupId, err: msg(err) }, 'createDebrief failed');
		}
	}
	return n;
}

/**
 * Build meeting_action_items from the recording's already-drafted action items
 * (recording_outputs). Resolves "who on the call owns this" via the diarized
 * speaker→contact mapping the user set on the review screen.
 */
async function extractActionItems(r: FollowupRow): Promise<ActionItemRow[]> {
	const [out] = await db
		.select({ actionItems: recordingOutputs.actionItems, summaryMd: recordingOutputs.summaryMd })
		.from(recordingOutputs)
		.where(eq(recordingOutputs.recordingId, r.recordingId as string))
		.limit(1);
	const raw = Array.isArray(out?.actionItems) ? (out!.actionItems as RawActionItem[]) : [];
	if (raw.length === 0) return [];

	// speakerLabel → contactId, from whatever mapping the user applied.
	const segs = await db
		.select({ label: recordingSegments.speakerLabel, contactId: recordingSegments.speakerContactId })
		.from(recordingSegments)
		.where(and(
			eq(recordingSegments.recordingId, r.recordingId as string),
			isNotNull(recordingSegments.speakerContactId),
		));
	const labelToContact = new Map<string, string>();
	for (const s of segs) if (s.contactId) labelToContact.set(s.label, s.contactId);

	const interim = raw
		.map((item) => ({
			text: typeof item?.text === 'string' ? item.text.trim() : '',
			ownerContactId: item.ownerSpeakerLabel ? labelToContact.get(item.ownerSpeakerLabel) ?? null : null,
			dueHint: typeof item?.dueHint === 'string' ? item.dueHint : null,
		}))
		.filter((x) => x.text);
	if (interim.length === 0) return [];

	// Sort each item into a bucket: ai (assistant drafts/creates it) | user | other.
	const classes = await classifyActionItems(r, out?.summaryMd ?? null, interim);

	const out2: ActionItemRow[] = [];
	for (let i = 0; i < interim.length; i++) {
		const it = interim[i];
		const cls = classes[i] ?? { bucket: 'user' as const, action: { kind: 'create_task' as const } };
		// A diarized contact owner always wins → "other"; if the model guessed
		// "other" but no contact mapped, fall back to the user's own list.
		let bucket: Bucket = it.ownerContactId ? 'other' : cls.bucket;
		if (bucket === 'other' && !it.ownerContactId) bucket = 'user';
		const proposedAction: ProposedAction = bucket === 'ai' ? cls.action : { kind: 'create_task' };

		const id = randomUUID();
		const description = truncate(it.text, 1000);
		await db.insert(meetingActionItems).values({
			id,
			organizationId: r.organizationId,
			followupId: r.followupId,
			appointmentId: r.appointmentId,
			description,
			ownerType: it.ownerContactId ? 'contact' : 'user',
			ownerContactId: it.ownerContactId,
			dueHint: it.dueHint,
			executableByAi: bucket === 'ai',
			bucket,
			proposedAction,
			status: 'proposed',
		});
		out2.push({ id, description, ownerContactId: it.ownerContactId, ownerType: it.ownerContactId ? 'contact' : 'user', bucket });
	}
	return out2;
}

// --- Step E: execute on approval (debrief marked DONE) ----------------------

async function executeApproved(result: FollowupTickResult): Promise<number> {
	const rows = await loadFollowups(['debrief_pending']);
	let n = 0;
	for (const r of rows) {
		try {
			if (!r.debriefTaskId) continue;
			// Approval (cron path) = the owner marked the Call Debrief task DONE.
			const [debrief] = await db
				.select({ status: tasks.status })
				.from(tasks)
				.where(eq(tasks.id, r.debriefTaskId))
				.limit(1);
			if (!debrief || debrief.status !== 'DONE') continue;

			await finalizeFollowupApproval(r.followupId);
			n += 1;
		} catch (err) {
			result.errors += 1;
			logger.warn({ followupId: r.followupId, err: msg(err) }, 'executeApproved failed');
		}
	}
	return n;
}

export interface ApprovalResult { intended: number; done: number; failed: number; alreadyDone: boolean }

/**
 * Execute the approved, AI-executable action items for one follow-up: create a
 * tracking task per item, log intended-vs-accomplished as a note, and mark the
 * follow-up completed. Shared by the cron (after detecting the debrief task is
 * DONE) and the debrief page's "Approve & run" action (immediate path).
 *
 * Idempotent: no-ops unless the follow-up is still `debrief_pending`, so a
 * double invocation (user approves, then cron fires) can't double-create tasks.
 * Caller is responsible for marking the debrief task DONE.
 */
export async function finalizeFollowupApproval(followupId: string): Promise<ApprovalResult> {
	const r = await loadFollowupById(followupId);
	if (!r || r.state !== 'debrief_pending') {
		return { intended: 0, done: 0, failed: 0, alreadyDone: true };
	}

	const pending = await db
		.select()
		.from(meetingActionItems)
		.where(and(
			eq(meetingActionItems.followupId, r.followupId),
			inArray(meetingActionItems.status, ['proposed', 'approved']),
		));

	const summaryMd = r.recordingId ? (await recordingSummary(r.recordingId))?.summaryMd ?? null : null;

	let done = 0, failed = 0;
	for (const item of pending) {
		const res = await executeActionItem(r, item, summaryMd);
		if (res === 'failed') failed += 1;
		else done += 1;
	}

	await db.update(meetingFollowups).set({
		state: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	}).where(eq(meetingFollowups.id, r.followupId));
	await logFollowupCompletion(r, done, 0);

	return { intended: pending.length, done, failed, alreadyDone: false };
}

/**
 * Execute ONE action item according to its bucket: AI draft_document → draft the
 * document; AI create_note → file a note; user/other → create a tracking task.
 * Marks the row executed (or failed) and returns the outcome. Shared by the bulk
 * approval and the per-item approval action.
 */
async function executeActionItem(
	r: FollowupRow,
	item: typeof meetingActionItems.$inferSelect,
	summaryMd: string | null,
): Promise<'done' | 'failed'> {
	try {
		const action = (item.proposedAction ?? {}) as ProposedAction;
		if (item.bucket === 'ai' && (action.kind === 'draft_document' || action.kind === 'send_booking_link')) {
			const { docId } = await draftDocument(r, item, summaryMd);
			await db.update(meetingActionItems).set({
				status: 'executed', resultDocId: docId, executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		} else if (item.bucket === 'ai' && action.kind === 'create_note') {
			await db.insert(notes).values({
				id: randomUUID(),
				userId: r.userId,
				organizationId: r.organizationId,
				contactId: item.ownerContactId ?? r.contactId,
				appointmentId: r.appointmentId,
				source: 'ai',
				body: item.description,
			});
			await db.update(meetingActionItems).set({
				status: 'executed', executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		} else {
			const owner = item.ownerContactId ? await contactName(item.ownerContactId) : null;
			const newTaskId = await createOrganizerTask({
				userId: r.userId,
				organizationId: r.organizationId,
				title: truncate(item.description, 200),
				description: `Follow-up from "${r.title}".${owner ? ` Owner: ${owner}.` : ''}`,
				reviewRequired: false,
				assignedContactIds: item.ownerContactId ? [item.ownerContactId] : [],
			});
			await linkTaskToAppointment(r.organizationId, newTaskId, r.appointmentId);
			await db.update(meetingActionItems).set({
				status: 'executed', resultTaskId: newTaskId, executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		}
		return 'done';
	} catch (err) {
		await db.update(meetingActionItems).set({
			status: 'failed', result: { error: msg(err) }, executedAt: new Date().toISOString(),
		}).where(eq(meetingActionItems.id, item.id));
		return 'failed';
	}
}

export interface ItemActionResult {
	ok: boolean;
	error?: string;
	status?: string;
	resultDocId?: string | null;
	resultTaskId?: string | null;
	followupCompleted: boolean;
}

/**
 * Per-item approval: execute a single action item now (silent — AI items draft
 * their document, user/other items create a task), then finalize the follow-up
 * if nothing is left undecided. Org-scoped against a forged id.
 */
export async function approveActionItem(
	organizationId: string,
	actionItemId: string,
	description?: string,
): Promise<ItemActionResult> {
	const [item] = await db
		.select()
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.id, actionItemId), eq(meetingActionItems.organizationId, organizationId)))
		.limit(1);
	if (!item) return { ok: false, error: 'Action item not found.', followupCompleted: false };
	if (item.status !== 'proposed' && item.status !== 'approved') {
		return { ok: true, status: item.status, followupCompleted: false };
	}

	const r = await loadFollowupById(item.followupId);
	if (!r) return { ok: false, error: 'Follow-up not found.', followupCompleted: false };

	// Honor an inline edit to the description made before approving.
	let live = item;
	const trimmed = description?.trim().slice(0, 1000);
	if (trimmed && trimmed !== item.description) {
		await db.update(meetingActionItems).set({ description: trimmed }).where(eq(meetingActionItems.id, item.id));
		live = { ...item, description: trimmed };
	}

	const summaryMd = r.recordingId ? (await recordingSummary(r.recordingId))?.summaryMd ?? null : null;
	const outcome = await executeActionItem(r, live, summaryMd);

	const [fresh] = await db
		.select({ status: meetingActionItems.status, resultDocId: meetingActionItems.resultDocId, resultTaskId: meetingActionItems.resultTaskId })
		.from(meetingActionItems)
		.where(eq(meetingActionItems.id, item.id))
		.limit(1);

	const completed = await maybeCompleteFollowup(item.followupId);
	return {
		ok: outcome === 'done',
		error: outcome === 'failed' ? 'The item could not be completed.' : undefined,
		status: fresh?.status,
		resultDocId: fresh?.resultDocId ?? null,
		resultTaskId: fresh?.resultTaskId ?? null,
		followupCompleted: completed,
	};
}

/** Per-item skip: mark one item skipped, then finalize the follow-up if done. */
export async function skipActionItem(organizationId: string, actionItemId: string): Promise<ItemActionResult> {
	const [item] = await db
		.select({ id: meetingActionItems.id, followupId: meetingActionItems.followupId, status: meetingActionItems.status })
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.id, actionItemId), eq(meetingActionItems.organizationId, organizationId)))
		.limit(1);
	if (!item) return { ok: false, error: 'Action item not found.', followupCompleted: false };
	if (item.status === 'proposed' || item.status === 'approved') {
		await db.update(meetingActionItems).set({ status: 'skipped' }).where(eq(meetingActionItems.id, item.id));
	}
	const completed = await maybeCompleteFollowup(item.followupId);
	return { ok: true, status: 'skipped', followupCompleted: completed };
}

/**
 * Finalize a follow-up once every item is resolved (none left proposed/approved):
 * mark its debrief task DONE, set state completed, write the summary note. Idempotent
 * — no-ops if items remain or the follow-up is already completed. Returns whether it
 * completed on this call (or was already completed).
 */
async function maybeCompleteFollowup(followupId: string): Promise<boolean> {
	const r = await loadFollowupById(followupId);
	if (!r) return false;
	if (r.state === 'completed') return true;

	const [{ remaining }] = await db
		.select({ remaining: sql<number>`count(*)::int` })
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.followupId, followupId), inArray(meetingActionItems.status, ['proposed', 'approved'])));
	if (Number(remaining ?? 0) > 0) return false;

	const [{ done }] = await db
		.select({ done: sql<number>`count(*)::int` })
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.followupId, followupId), eq(meetingActionItems.status, 'executed')));

	if (r.debriefTaskId) {
		await db.update(tasks)
			.set({ status: 'DONE', updatedAt: new Date().toISOString() })
			.where(and(eq(tasks.id, r.debriefTaskId), eq(tasks.organizationId, r.organizationId)));
	}
	await db.update(meetingFollowups).set({
		state: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	}).where(eq(meetingFollowups.id, followupId));
	await logFollowupCompletion(r, Number(done ?? 0), 0);
	return true;
}

// --- interactive ("create with me") approval --------------------------------

export interface QueuedDeliverable {
	id: string;
	description: string;
	/** Canvas-renderable kind. 'contract' is presented as 'letter' (no contract
	 *  renderer yet); 'deck' is supported by the canvas. */
	docKind: 'letter' | 'email' | 'resolution' | 'deck';
	docTitle: string;
}

export interface BeginInteractiveResult {
	ok: boolean;
	queue: QueuedDeliverable[];
	alreadyDone: boolean;
}

/**
 * Approve a debrief into INTERACTIVE mode. Unlike finalizeFollowupApproval
 * (which silently drafts everything), this leaves each AI draft_document item
 * QUEUED (status 'approved') so the workspace session can draft them one at a
 * time with the user. Trivial AI items (create_note) are done immediately;
 * user/other items become tracking tasks, same as the silent path. The
 * follow-up moves to state 'executing' and stays there until the last queued
 * deliverable is saved (see saveInteractiveDeliverable).
 *
 * Idempotent: no-ops unless still debrief_pending.
 */
export async function beginInteractiveApproval(followupId: string): Promise<BeginInteractiveResult> {
	const r = await loadFollowupById(followupId);
	if (!r || r.state !== 'debrief_pending') {
		return { ok: true, queue: [], alreadyDone: true };
	}

	const pending = await db
		.select()
		.from(meetingActionItems)
		.where(and(
			eq(meetingActionItems.followupId, r.followupId),
			inArray(meetingActionItems.status, ['proposed', 'approved']),
		));

	const queue: QueuedDeliverable[] = [];
	for (const item of pending) {
		const action = (item.proposedAction ?? {}) as ProposedAction;
		if (item.bucket === 'ai' && action.kind === 'draft_document') {
			// Queue for the interactive session — left as 'approved', not executed.
			// 'contract' has no canvas renderer yet → present as 'letter'.
			const canvasKind: QueuedDeliverable['docKind'] =
				action.docKind === 'deck' ? 'deck'
				: action.docKind === 'email' ? 'email'
				: action.docKind === 'resolution' ? 'resolution'
				: 'letter';
			await db.update(meetingActionItems).set({ status: 'approved' }).where(eq(meetingActionItems.id, item.id));
			queue.push({
				id: item.id,
				description: item.description,
				docKind: canvasKind,
				docTitle: action.docTitle || item.description.slice(0, 120),
			});
		} else if (item.bucket === 'ai' && action.kind === 'send_booking_link') {
			// Deterministic (insert the real link) — draft it now, no Q&A needed.
			const { docId } = await draftDocument(r, item, null);
			await db.update(meetingActionItems).set({
				status: 'executed', resultDocId: docId, executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		} else if (item.bucket === 'ai' && action.kind === 'create_note') {
			// Trivial — just do it now; no Q&A needed.
			await db.insert(notes).values({
				id: randomUUID(),
				userId: r.userId,
				organizationId: r.organizationId,
				contactId: item.ownerContactId ?? r.contactId,
				appointmentId: r.appointmentId,
				source: 'ai',
				body: item.description,
			});
			await db.update(meetingActionItems).set({
				status: 'executed', executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		} else {
			// user / other → a tracking task on the right person's list.
			const owner = item.ownerContactId ? await contactName(item.ownerContactId) : null;
			const newTaskId = await createOrganizerTask({
				userId: r.userId,
				organizationId: r.organizationId,
				title: truncate(item.description, 200),
				description: `Follow-up from "${r.title}".${owner ? ` Owner: ${owner}.` : ''}`,
				reviewRequired: false,
				assignedContactIds: item.ownerContactId ? [item.ownerContactId] : [],
			});
			await linkTaskToAppointment(r.organizationId, newTaskId, r.appointmentId);
			await db.update(meetingActionItems).set({
				status: 'executed', resultTaskId: newTaskId, executedAt: new Date().toISOString(),
			}).where(eq(meetingActionItems.id, item.id));
		}
	}

	await db.update(meetingFollowups).set({
		state: queue.length > 0 ? 'executing' : 'completed',
		completedAt: queue.length > 0 ? null : new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}).where(eq(meetingFollowups.id, r.followupId));

	if (queue.length === 0) await logFollowupCompletion(r, 0, 0);
	return { ok: true, queue, alreadyDone: false };
}

export interface SaveDeliverableResult {
	ok: boolean;
	error?: string;
	docId?: string;
	remaining: number;
	completed: boolean;
}

/**
 * Persist one finished deliverable from the interactive session: writes the
 * document to organizer_documents, marks its action item executed, and — when
 * no queued ('approved') AI items remain — finalizes the follow-up. Org-scoped
 * so a forged item id can't touch another org's data.
 */
export async function saveInteractiveDeliverable(opts: {
	organizationId: string;
	userId: string;
	actionItemId: string;
	kind: 'letter' | 'email' | 'resolution' | 'deck';
	title: string;
	body: string;
}): Promise<SaveDeliverableResult> {
	const [item] = await db
		.select()
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.id, opts.actionItemId), eq(meetingActionItems.organizationId, opts.organizationId)))
		.limit(1);
	if (!item) return { ok: false, error: 'Action item not found.', remaining: 0, completed: false };

	const r = await loadFollowupById(item.followupId);
	if (!r) return { ok: false, error: 'Follow-up not found.', remaining: 0, completed: false };

	const docId = randomUUID();
	await db.insert(organizerDocuments).values({
		id: docId,
		organizationId: opts.organizationId,
		userId: opts.userId,
		kind: opts.kind,
		title: opts.title.slice(0, 200) || item.description.slice(0, 200),
		body: opts.body,
		contactId: item.ownerContactId ?? r.contactId ?? null,
	});
	await db.update(meetingActionItems).set({
		status: 'executed', resultDocId: docId, executedAt: new Date().toISOString(),
	}).where(eq(meetingActionItems.id, item.id));

	// Any AI deliverables still queued for this follow-up?
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(meetingActionItems)
		.where(and(eq(meetingActionItems.followupId, item.followupId), eq(meetingActionItems.status, 'approved')));
	const remaining = Number(n ?? 0);

	if (remaining === 0) {
		const [{ drafted }] = await db
			.select({ drafted: sql<number>`count(*)::int` })
			.from(meetingActionItems)
			.where(and(eq(meetingActionItems.followupId, item.followupId), isNotNull(meetingActionItems.resultDocId)));
		await db.update(meetingFollowups).set({
			state: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		}).where(eq(meetingFollowups.id, item.followupId));
		await logFollowupCompletion(r, Number(drafted ?? 0), 0);
	}

	return { ok: true, docId, remaining, completed: remaining === 0 };
}

/** Shared intended-vs-accomplished note written when a follow-up completes. */
async function logFollowupCompletion(r: FollowupRow, drafted: number, tasksCreated: number): Promise<void> {
	await db.insert(notes).values({
		id: randomUUID(),
		userId: r.userId,
		organizationId: r.organizationId,
		contactId: r.contactId,
		appointmentId: r.appointmentId,
		source: 'ai',
		body:
			`Call debrief actioned for "${r.title}".\n` +
			`AI handled ${drafted} item${drafted === 1 ? '' : 's'}` +
			(tasksCreated ? `; created ${tasksCreated} task${tasksCreated === 1 ? '' : 's'}.` : '.'),
	});
}

// --- shared helpers ---------------------------------------------------------

interface FollowupRow {
	followupId: string;
	appointmentId: string;
	organizationId: string;
	userId: string;
	state: string;
	chaseTaskId: string | null;
	debriefTaskId: string | null;
	recordingId: string | null;
	meetingEndedAt: string;
	title: string;
	contactId: string | null;
	startsAt: string;
}

type Bucket = 'ai' | 'user' | 'other';
type DocKind = 'letter' | 'email' | 'resolution' | 'contract' | 'deck';
const DOC_KINDS: DocKind[] = ['letter', 'email', 'resolution', 'contract', 'deck'];
type ProposedAction =
	| { kind: 'draft_document'; docKind: DocKind; docTitle: string }
	| { kind: 'send_booking_link' }
	| { kind: 'create_note' }
	| { kind: 'create_task' };
interface ItemClass { bucket: Bucket; action: ProposedAction }

interface ActionItemRow { id: string; description: string; ownerContactId: string | null; ownerType: string; bucket: Bucket }
interface RawActionItem { text?: unknown; ownerSpeakerLabel?: string | null; dueHint?: unknown }

async function loadFollowups(states: string[], extra?: ReturnType<typeof and>): Promise<FollowupRow[]> {
	return db
		.select({
			followupId: meetingFollowups.id,
			appointmentId: meetingFollowups.appointmentId,
			organizationId: meetingFollowups.organizationId,
			userId: meetingFollowups.userId,
			state: meetingFollowups.state,
			chaseTaskId: meetingFollowups.chaseTaskId,
			debriefTaskId: meetingFollowups.debriefTaskId,
			recordingId: meetingFollowups.recordingId,
			meetingEndedAt: meetingFollowups.meetingEndedAt,
			title: appointments.title,
			contactId: appointments.contactId,
			startsAt: appointments.startsAt,
		})
		.from(meetingFollowups)
		.innerJoin(appointments, eq(appointments.id, meetingFollowups.appointmentId))
		.innerJoin(organizations, eq(organizations.id, meetingFollowups.organizationId))
		.where(extra ? and(inArray(meetingFollowups.state, states), extra) : inArray(meetingFollowups.state, states))
		.limit(MAX_PER_TICK);
}

async function loadFollowupById(followupId: string): Promise<FollowupRow | null> {
	const [row] = await db
		.select({
			followupId: meetingFollowups.id,
			appointmentId: meetingFollowups.appointmentId,
			organizationId: meetingFollowups.organizationId,
			userId: meetingFollowups.userId,
			state: meetingFollowups.state,
			chaseTaskId: meetingFollowups.chaseTaskId,
			debriefTaskId: meetingFollowups.debriefTaskId,
			recordingId: meetingFollowups.recordingId,
			meetingEndedAt: meetingFollowups.meetingEndedAt,
			title: appointments.title,
			contactId: appointments.contactId,
			startsAt: appointments.startsAt,
		})
		.from(meetingFollowups)
		.innerJoin(appointments, eq(appointments.id, meetingFollowups.appointmentId))
		.where(eq(meetingFollowups.id, followupId))
		.limit(1);
	return row ?? null;
}

async function createOrganizerTask(opts: {
	userId: string;
	organizationId: string;
	title: string;
	description: string;
	reviewRequired: boolean;
	assignedContactIds: string[];
	page?: string;
	entityId?: string;
	entityType?: string;
}): Promise<string> {
	const id = randomUUID();
	await db.insert(tasks).values({
		id,
		userId: opts.userId,
		organizationId: opts.organizationId,
		product: 'organizer',
		page: opts.page ?? '/organizer/tasks',
		entityId: opts.entityId ?? null,
		entityType: opts.entityType ?? null,
		title: opts.title,
		description: opts.description,
		status: 'OPEN',
		source: 'ai',
		autoCreated: true,
		reviewRequired: opts.reviewRequired,
		assignedToUsers: [opts.userId],
		assignedToContacts: opts.assignedContactIds,
		subitems: [],
	});
	return id;
}

async function linkTaskToAppointment(organizationId: string, taskId: string, appointmentId: string): Promise<void> {
	await db.insert(taskLinks)
		.values({ id: randomUUID(), organizationId, taskId, entityType: 'appointment', entityId: appointmentId })
		.onConflictDoNothing();
}

async function markTaskDone(taskId: string): Promise<void> {
	await db.update(tasks)
		.set({ status: 'DONE', updatedAt: new Date().toISOString() })
		.where(and(eq(tasks.id, taskId), eq(tasks.status, 'OPEN')));
}

async function contactName(contactId: string | null): Promise<string | null> {
	if (!contactId) return null;
	const [c] = await db
		.select({ name: contacts.contactName })
		.from(contacts)
		.where(eq(contacts.id, contactId))
		.limit(1);
	return c?.name ?? null;
}

async function recordingSummary(recordingId: string): Promise<{ summaryMd: string | null; decisions: string[] } | null> {
	const [out] = await db
		.select({ summaryMd: recordingOutputs.summaryMd, decisions: recordingOutputs.decisions })
		.from(recordingOutputs)
		.where(eq(recordingOutputs.recordingId, recordingId))
		.limit(1);
	if (!out) return null;
	const decisions = Array.isArray(out.decisions)
		? (out.decisions as unknown[]).filter((d): d is string => typeof d === 'string')
		: [];
	return { summaryMd: out.summaryMd ?? null, decisions };
}

function buildDebriefDescription(opts: {
	title: string;
	who: string | null;
	summary: { summaryMd: string | null; decisions: string[] } | null;
	items: ActionItemRow[];
	hasRecording: boolean;
}): string {
	const lines: string[] = [];
	lines.push(`Debrief for "${opts.title}"${opts.who ? ` with ${opts.who}` : ''}.`);
	lines.push('');

	if (opts.summary?.summaryMd) {
		lines.push('**Summary**', opts.summary.summaryMd.trim(), '');
	}
	if (opts.summary?.decisions.length) {
		lines.push('**Decisions**');
		for (const d of opts.summary.decisions) lines.push(`- ${d}`);
		lines.push('');
	}

	if (opts.items.length) {
		lines.push('**🤖 Action items RocketSuite will track for you**');
		for (const it of opts.items) {
			lines.push(`- ${it.description}${it.ownerType === 'contact' ? ' _(owner is someone on the call)_' : ''}`);
		}
		lines.push('');
		lines.push('✅ When you mark this task done, RocketSuite will create one tracking task per item above. It will not email or text anyone on your behalf.');
	} else if (opts.hasRecording) {
		lines.push('_No clear action items were detected in the transcript. Review the recording and add any follow-ups yourself, then mark this task done._');
	} else {
		lines.push('_Notes came in for this meeting but were not auto-analyzed. Review the linked note, add any follow-ups, then mark this task done._');
	}

	return lines.join('\n');
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// --- AI classification + drafting -------------------------------------------

type ActionItemRecord = typeof meetingActionItems.$inferSelect;

const CLASSIFY_SYSTEM = `You sort meeting action items by who carries them out. The assistant is INTERNAL-ONLY: it never sends, emails, texts, or calls anyone — but it CAN draft documents, write notes, and prepare the user's booking link for the user to review and send.

Pick exactly one bucket per item:
- "ai": the deliverable is something the assistant can prepare — a document, a note, or sharing the user's calendar booking link. Choose "ai" whenever written content needs to be PREPARED, even if a human ultimately sends it (the assistant drafts; the user sends). e.g. "send the proposal", "recap email", "put together the agreement", "send them my booking link" are all "ai".
- "user": a human action with no preparable artifact — make a phone call, pay an invoice, attend a meeting, or make a decision.
- "other": clearly owned by someone else who was on the call.

For "ai", set actionKind:
- "send_booking_link" when the item is about sharing the user's scheduling/booking link so the other party can pick a time (e.g. "send my booking link", "let them schedule a demo"). docKind "none", docTitle "".
- "draft_document" when the deliverable is a written document. Set docKind:
    • "email" — an email/recap to send
    • "letter" — a formal letter
    • "resolution" — a board/corporate resolution
    • "contract" — ANY contract or agreement (service agreement, NDA, SOW, MSA, engagement letter). Use "contract", never "resolution", for agreements.
    • "deck" — a presentation / slideshow / pitch deck
  and a short docTitle.
- "create_note" only for a brief internal note.
For "user"/"other": actionKind "none", docKind "none", docTitle "".`;

const DRAFT_SYSTEM = `You are drafting a business document for the user to review before they send it. Output only the document body — no preamble, no explanation, no markdown code fences. Keep it professional and concise.`;

const CONTRACT_SYSTEM = `You are drafting a CONTRACT/agreement for the user to review with their own counsel before use. Produce a properly structured agreement: a title, the parties, recitals, and numbered clauses covering scope/services, term, fees & payment, confidentiality, IP/ownership, termination, liability, and governing law as appropriate to the deal. Use placeholders like [Party Name], [Address], [Effective Date], [Amount] where specifics are unknown — do not invent facts. Output only the document body (markdown headings/numbered lists allowed), no preamble or code fences. Begin the body with this exact line: "**AI-GENERATED DRAFT — for review only. Not legal advice. Have qualified counsel review before signing.**"`;

const DECK_SYSTEM = `You are drafting a slide presentation. Write the body as slides separated by a line containing only "---". Each slide starts with "# Slide Title", then "-" bullet lines, and optional "> " speaker-note lines. Do NOT include images. Output only the slide body, no preamble or code fences.`;

/** Resolve the user's public booking link (creating a default profile if needed).
 *  Returns the best-specific URL (first event type if present, else the profile). */
async function bookingLinkForUser(userId: string, organizationId: string): Promise<string | null> {
	try {
		const [u] = await db.select({ fullName: users.fullName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
		const bundle = await getOrCreateBookingProfile({
			userId,
			organizationId,
			seed: u?.fullName || u?.email || 'meet',
		});
		const ev = bundle.eventTypes.find((e) => e.isActive) ?? bundle.eventTypes[0];
		return ev ? eventTypeUrl(bundle.profile.slug, ev.slug) : publicBookingUrl(bundle.profile.slug);
	} catch (err) {
		logger.warn({ userId, err: msg(err) }, 'bookingLinkForUser failed');
		return null;
	}
}

/** LLM triage of action items into ai/user/other (+ the ai action). Falls back
 * to a safe heuristic if the call fails, so a debrief never blocks on it. */
async function classifyActionItems(
	r: FollowupRow,
	summaryMd: string | null,
	items: Array<{ text: string; ownerContactId: string | null }>,
): Promise<ItemClass[]> {
	const fallback = items.map<ItemClass>((it) => ({
		bucket: it.ownerContactId ? 'other' : 'user',
		action: { kind: 'create_task' },
	}));
	if (items.length === 0) return fallback;

	try {
		const res = await chatCompletion(
			{ userId: r.userId, orgId: r.organizationId, actor: 'system', feature: 'debrief-classify' },
			{
				model: 'gpt-4o-mini',
				temperature: 0.1,
				messages: [
					{ role: 'system', content: CLASSIFY_SYSTEM },
					{
						role: 'user',
						content:
							`Meeting: ${r.title}\nSummary: ${summaryMd ?? '(none)'}\n\n` +
							`Action items:\n${items.map((it, i) => `${i}. ${it.text}`).join('\n')}\n\n` +
							`Classify each by its index.`,
					},
				],
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: 'ItemBuckets',
						strict: true,
						schema: {
							type: 'object',
							additionalProperties: false,
							required: ['items'],
							properties: {
								items: {
									type: 'array',
									items: {
										type: 'object',
										additionalProperties: false,
										required: ['index', 'bucket', 'actionKind', 'docKind', 'docTitle'],
										properties: {
											index: { type: 'number' },
											bucket: { type: 'string', enum: ['ai', 'user', 'other'] },
											actionKind: { type: 'string', enum: ['draft_document', 'send_booking_link', 'create_note', 'none'] },
											docKind: { type: 'string', enum: ['letter', 'email', 'resolution', 'contract', 'deck', 'none'] },
											docTitle: { type: 'string' },
										},
									},
								},
							},
						},
					},
				},
			},
		);
		const raw = res.choices[0]?.message?.content ?? '';
		const parsed = JSON.parse(raw) as {
			items: Array<{ index: number; bucket: Bucket; actionKind: string; docKind: string; docTitle: string }>;
		};
		const byIndex = new Map(parsed.items.map((p) => [p.index, p]));
		return items.map((it, i) => {
			const p = byIndex.get(i);
			if (!p) return fallback[i];
			let action: ProposedAction = { kind: 'create_task' };
			if (p.bucket === 'ai') {
				if (p.actionKind === 'send_booking_link') {
					action = { kind: 'send_booking_link' };
				} else if (p.actionKind === 'draft_document') {
					const docKind = (DOC_KINDS.includes(p.docKind as DocKind) ? p.docKind : 'letter') as DocKind;
					action = { kind: 'draft_document', docKind, docTitle: (p.docTitle || it.text).slice(0, 120) };
				} else {
					action = { kind: 'create_note' };
				}
			}
			return { bucket: p.bucket, action };
		});
	} catch (err) {
		logger.warn({ followupId: r.followupId, err: msg(err) }, 'debrief classify failed; using fallback');
		return fallback;
	}
}

/**
 * Draft an "ai" action item and save it to organizer_documents. Handles
 * draft_document (letter/email/resolution/contract/deck) and send_booking_link
 * (drafts an email containing the user's REAL booking link). `contract` is a
 * draft labeled "not legal advice"; it is stored under the renderable 'letter'
 * kind (the canvas/documents UI has no dedicated contract renderer yet).
 */
async function draftDocument(
	r: FollowupRow,
	item: ActionItemRecord,
	summaryMd: string | null,
): Promise<{ docId: string; title: string }> {
	const action = (item.proposedAction ?? {}) as ProposedAction;

	// Resolve the intent kind, the per-kind drafting prompt, the user instruction,
	// and the storage kind the documents UI can actually render.
	let intent: DocKind = 'letter';
	let system = DRAFT_SYSTEM;
	let instruction = `Meeting: ${r.title}\nContext: ${summaryMd ?? '(none)'}\nDeliverable: ${item.description}\n\nDraft the document.`;
	let title = item.description.slice(0, 200);

	if (action.kind === 'send_booking_link') {
		intent = 'email';
		const link = await bookingLinkForUser(r.userId, r.organizationId);
		const who = r.contactId ? await contactName(r.contactId) : null;
		title = 'Booking link';
		system = DRAFT_SYSTEM;
		instruction = link
			? `Meeting: ${r.title}\nContext: ${summaryMd ?? '(none)'}\n\nDraft a short, friendly email${who ? ` to ${who}` : ''} inviting them to book a time using this scheduling link: ${link}\nInclude the link verbatim exactly once. Do not invent any other URL.`
			: `Draft a short email${who ? ` to ${who}` : ''} inviting them to schedule a time. Leave a clear placeholder "[your booking link]" where the link goes — do not invent a URL.`;
	} else if (action.kind === 'draft_document') {
		intent = DOC_KINDS.includes(action.docKind) ? action.docKind : 'letter';
		title = (action.docTitle || item.description).slice(0, 200);
		if (intent === 'contract') {
			system = CONTRACT_SYSTEM;
			instruction = `Meeting: ${r.title}\nContext: ${summaryMd ?? '(none)'}\nAgreement needed: ${item.description}\n\nDraft the contract.`;
		} else if (intent === 'deck') {
			system = DECK_SYSTEM;
			instruction = `Meeting: ${r.title}\nContext: ${summaryMd ?? '(none)'}\nPresentation: ${item.description}\n\nDraft the slides.`;
		} else {
			instruction = `Meeting: ${r.title}\nContext: ${summaryMd ?? '(none)'}\nDeliverable: ${item.description}\n\nDraft the ${intent}.`;
		}
	}

	let body: string;
	try {
		const res = await chatCompletion(
			{ userId: r.userId, orgId: r.organizationId, actor: 'system', feature: 'debrief-draft-doc' },
			{
				model: 'gpt-4o-mini',
				temperature: 0.3,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: instruction },
				],
			},
		);
		body = res.choices[0]?.message?.content ?? '';
	} catch (err) {
		body = `[Draft could not be generated automatically: ${msg(err)}]\n\n${item.description}`;
	}

	// Storage kind must be one the documents/canvas UI can render. 'contract'
	// has no dedicated renderer yet (Phase 3), so persist it as a 'letter'.
	const storageKind = intent === 'contract' ? 'letter' : intent;

	const docId = randomUUID();
	await db.insert(organizerDocuments).values({
		id: docId,
		organizationId: r.organizationId,
		userId: r.userId,
		kind: storageKind,
		title,
		body,
		contactId: item.ownerContactId ?? r.contactId ?? null,
	});
	return { docId, title };
}
