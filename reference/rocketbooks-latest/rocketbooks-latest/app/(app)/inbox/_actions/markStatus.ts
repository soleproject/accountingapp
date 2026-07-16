'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';

/**
 * Triage/archive/un-archive a message. Pure status flip; doesn't touch
 * ai_status. (Sending a reply via sendReplyAction is the only path that
 * also flips ai_status alongside status.)
 */
export interface MarkStatusInput {
	messageId: string;
	status: 'open' | 'triaged' | 'archived';
}

export interface MarkStatusResult {
	ok: boolean;
	error?: string;
}

export async function markStatusAction(input: MarkStatusInput): Promise<MarkStatusResult> {
	const user = await requireSession();
	if (!['open', 'triaged', 'archived'].includes(input.status)) {
		return { ok: false, error: 'invalid status' };
	}

	const [m] = await db
		.select({ id: inboxMessages.id })
		.from(inboxMessages)
		.where(and(eq(inboxMessages.id, input.messageId), eq(inboxMessages.userId, user.id)))
		.limit(1);
	if (!m) return { ok: false, error: 'Message not found' };

	await db
		.update(inboxMessages)
		.set({
			status: input.status,
			triagedAt: input.status === 'triaged' ? new Date().toISOString() : null,
		})
		.where(eq(inboxMessages.id, input.messageId));

	revalidatePath('/inbox');
	revalidatePath('/organizer/inbox');
	revalidatePath(`/inbox/${input.messageId}`);
	revalidatePath(`/organizer/inbox/${input.messageId}`);
	return { ok: true };
}
