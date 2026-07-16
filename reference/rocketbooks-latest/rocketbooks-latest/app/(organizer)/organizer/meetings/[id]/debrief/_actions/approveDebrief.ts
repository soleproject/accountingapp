'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { meetingActionItems, meetingFollowups, tasks } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
	finalizeFollowupApproval,
	beginInteractiveApproval,
	approveActionItem,
	skipActionItem,
	type QueuedDeliverable,
} from '@/lib/meetings/followups';

export interface ApproveDebriefInput {
	appointmentId: string;
	items: Array<{ id: string; include: boolean; description: string }>;
}

export interface ApproveDebriefResult {
	ok: boolean;
	error?: string;
	done?: number;
	failed?: number;
	alreadyDone?: boolean;
}

export interface BeginInteractiveDebriefResult {
	ok: boolean;
	error?: string;
	queue?: QueuedDeliverable[];
	alreadyDone?: boolean;
}

/**
 * Apply the user's per-item edits + include/skip choices and mark the Call
 * Debrief task DONE. Shared by both approve paths. Returns the followup id, or
 * null if it's not in a pending state (already actioned elsewhere).
 */
async function applyEditsAndMarkDone(
	input: ApproveDebriefInput,
	orgId: string,
): Promise<{ followupId: string } | { alreadyDone: true } | { notFound: true }> {
	const [fu] = await db
		.select({ id: meetingFollowups.id, state: meetingFollowups.state, debriefTaskId: meetingFollowups.debriefTaskId })
		.from(meetingFollowups)
		.where(and(eq(meetingFollowups.appointmentId, input.appointmentId), eq(meetingFollowups.organizationId, orgId)))
		.limit(1);

	if (!fu) return { notFound: true };
	if (fu.state !== 'debrief_pending') return { alreadyDone: true };

	for (const it of input.items) {
		const description = it.description.trim().slice(0, 1000);
		await db
			.update(meetingActionItems)
			.set({ description: description || 'Follow-up', status: it.include ? 'approved' : 'skipped' })
			.where(and(
				eq(meetingActionItems.id, it.id),
				eq(meetingActionItems.followupId, fu.id),
				eq(meetingActionItems.organizationId, orgId),
			));
	}

	if (fu.debriefTaskId) {
		await db
			.update(tasks)
			.set({ status: 'DONE', updatedAt: new Date().toISOString() })
			.where(and(eq(tasks.id, fu.debriefTaskId), eq(tasks.organizationId, orgId)));
	}
	return { followupId: fu.id };
}

/**
 * "Approve & create with me" — interactive path. Applies edits, marks the
 * debrief done, then QUEUES the AI deliverables (rather than drafting them
 * silently) and returns the queue so the client can launch the workspace
 * session that drafts each one with the user.
 */
export async function beginInteractiveDebriefAction(input: ApproveDebriefInput): Promise<BeginInteractiveDebriefResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const applied = await applyEditsAndMarkDone(input, orgId);
	if ('notFound' in applied) return { ok: false, error: 'Debrief not found.' };
	if ('alreadyDone' in applied) return { ok: true, alreadyDone: true };

	const res = await beginInteractiveApproval(applied.followupId);
	revalidatePath(`/organizer/meetings/${input.appointmentId}/debrief`);
	revalidatePath('/organizer/tasks');
	revalidatePath('/organizer/dashboard');
	return { ok: true, queue: res.queue, alreadyDone: res.alreadyDone };
}

/**
 * "Approve & run" from the debrief page. Applies the user's per-item edits and
 * include/skip choices, marks the Call Debrief task DONE, then immediately
 * executes via the shared engine path (instead of waiting for the cron).
 */
export interface ItemActionInput {
	appointmentId: string;
	itemId: string;
	/** Optional inline-edited description applied before approving. */
	description?: string;
}

export interface ItemActionResultDto {
	ok: boolean;
	error?: string;
	status?: string;
	resultDocId?: string | null;
	resultTaskId?: string | null;
	followupCompleted?: boolean;
}

/** Per-item "Approve" / "Draft it" — silently execute this one item now. */
export async function approveItemAction(input: ItemActionInput): Promise<ItemActionResultDto> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const res = await approveActionItem(orgId, input.itemId, input.description);
	revalidatePath(`/organizer/meetings/${input.appointmentId}/debrief`);
	if (res.followupCompleted) {
		revalidatePath('/organizer/tasks');
		revalidatePath('/organizer/dashboard');
	}
	return {
		ok: res.ok,
		error: res.error,
		status: res.status,
		resultDocId: res.resultDocId,
		resultTaskId: res.resultTaskId,
		followupCompleted: res.followupCompleted,
	};
}

/** Per-item "Skip" — mark this one item skipped. */
export async function skipItemAction(input: ItemActionInput): Promise<ItemActionResultDto> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const res = await skipActionItem(orgId, input.itemId);
	revalidatePath(`/organizer/meetings/${input.appointmentId}/debrief`);
	if (res.followupCompleted) {
		revalidatePath('/organizer/tasks');
		revalidatePath('/organizer/dashboard');
	}
	return { ok: res.ok, error: res.error, status: res.status, followupCompleted: res.followupCompleted };
}

export async function approveDebriefAction(input: ApproveDebriefInput): Promise<ApproveDebriefResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const applied = await applyEditsAndMarkDone(input, orgId);
	if ('notFound' in applied) return { ok: false, error: 'Debrief not found.' };
	if ('alreadyDone' in applied) return { ok: true, alreadyDone: true };

	const res = await finalizeFollowupApproval(applied.followupId);

	revalidatePath(`/organizer/meetings/${input.appointmentId}/debrief`);
	revalidatePath('/organizer/tasks');
	revalidatePath('/organizer/dashboard');
	return { ok: true, done: res.done, failed: res.failed };
}
