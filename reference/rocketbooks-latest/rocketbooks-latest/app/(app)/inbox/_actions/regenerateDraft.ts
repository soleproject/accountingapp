'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { generateDraft } from '@/lib/email-accounts/ai-draft';

/**
 * Re-run the AI draft for a message the user owns. Used when the first
 * draft is bad — also useful for `skipped_noise` messages where the
 * user clicked "draft a reply anyway."
 *
 * Server action returns { ok, error? } so the client can surface the
 * outcome inline; on success it just calls revalidatePath so the page
 * re-renders with the new draft.
 */
export interface RegenerateDraftInput {
	messageId: string;
}

export interface RegenerateDraftResult {
	ok: boolean;
	error?: string;
}

export async function regenerateDraftAction(
	input: RegenerateDraftInput,
): Promise<RegenerateDraftResult> {
	const user = await requireSession();

	const [m] = await db
		.select({
			id: inboxMessages.id,
			userId: inboxMessages.userId,
			fromAddress: inboxMessages.fromAddress,
			fromName: inboxMessages.fromName,
			subject: inboxMessages.subject,
			body: inboxMessages.body,
			threadId: inboxMessages.threadId,
			receivedAt: inboxMessages.receivedAt,
			aiStatus: inboxMessages.aiStatus,
		})
		.from(inboxMessages)
		.where(and(eq(inboxMessages.id, input.messageId), eq(inboxMessages.userId, user.id)))
		.limit(1);

	if (!m) return { ok: false, error: 'Message not found' };
	if (m.aiStatus === 'sent') return { ok: false, error: 'Cannot regenerate after sending' };

	try {
		const draft = await generateDraft({
			id: m.id,
			userId: m.userId,
			fromAddress: m.fromAddress,
			fromName: m.fromName,
			subject: m.subject,
			body: m.body,
			threadId: m.threadId,
			receivedAt: m.receivedAt,
		});
		await db
			.update(inboxMessages)
			.set({
				aiStatus: 'drafted',
				aiDraftSubject: draft.subject,
				aiDraftHtml: draft.html,
				aiDraftText: draft.text,
				aiModel: draft.model,
				aiDraftedAt: new Date().toISOString(),
				aiSkipReason: null,
			})
			.where(eq(inboxMessages.id, input.messageId));

		revalidatePath(`/inbox/${input.messageId}`);
		revalidatePath(`/organizer/inbox/${input.messageId}`);
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await db
			.update(inboxMessages)
			.set({ aiStatus: 'failed', aiSkipReason: msg.slice(0, 1000) })
			.where(eq(inboxMessages.id, input.messageId));
		return { ok: false, error: msg };
	}
}
