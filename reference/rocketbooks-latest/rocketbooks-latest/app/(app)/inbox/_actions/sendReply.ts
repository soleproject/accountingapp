'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages, emailAccounts, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { sendReply } from '@/lib/email-accounts/send-reply';
import {
	getUserEmailSignature,
	appendSignatureHtml,
	appendSignatureText,
} from '@/lib/email-accounts/signature';
import { logger } from '@/lib/logger';

/**
 * User-initiated reply send. Gates strictly:
 *   - Session required
 *   - Message must belong to the requesting user
 *   - Message must have an email_account_id we can decrypt against
 *
 * On success: flips ai_status='sent', status='triaged', stores
 * sent_message_id + sent_at. We revalidate both shells so the row's
 * status badge updates whether the user came from /inbox or /organizer/inbox.
 */
export interface SendReplyInput {
	messageId: string;
	subject: string;
	html: string;
	/** Plain-text fallback. Caller should derive from html if not provided. */
	text: string;
}

export interface SendReplyResult {
	ok: boolean;
	error?: string;
	sentMessageId?: string;
}

export async function sendReplyAction(input: SendReplyInput): Promise<SendReplyResult> {
	const user = await requireSession();

	if (!input.messageId) return { ok: false, error: 'messageId is required' };
	if (!input.subject.trim()) return { ok: false, error: 'Subject is required' };
	if (!input.html.trim() || !input.text.trim()) {
		return { ok: false, error: 'Body is required' };
	}

	// Single query: look up the message AND its account in one go. The
	// join enforces ownership both for the message (userId) and for the
	// linked email_account (also userId on email_accounts).
	const [row] = await db
		.select({
			messageId: inboxMessages.id,
			messageUserId: inboxMessages.userId,
			fromAddress: inboxMessages.fromAddress,
			threadId: inboxMessages.threadId,
			externalId: inboxMessages.externalId,
			emailAccountId: inboxMessages.emailAccountId,
			accountId: emailAccounts.id,
			emailAddress: emailAccounts.emailAddress,
			smtpHost: emailAccounts.smtpHost,
			smtpPort: emailAccounts.smtpPort,
			smtpSecure: emailAccounts.smtpSecure,
			encryptedPassword: emailAccounts.encryptedPassword,
			encryptionIv: emailAccounts.encryptionIv,
			encryptionAuthTag: emailAccounts.encryptionAuthTag,
		})
		.from(inboxMessages)
		.leftJoin(emailAccounts, eq(emailAccounts.id, inboxMessages.emailAccountId))
		.where(and(eq(inboxMessages.id, input.messageId), eq(inboxMessages.userId, user.id)))
		.limit(1);

	if (!row) return { ok: false, error: 'Message not found' };
	if (!row.accountId) {
		return {
			ok: false,
			error:
				'No email account linked to this message — was the source account disconnected? Reconnect the account on /inbox to reply.',
		};
	}

	const [me] = await db
		.select({ fullName: users.fullName })
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	// Append the user's saved email signature to the outgoing body. Done here
	// (server-side, at send) so every sent reply carries it regardless of what
	// the user edited in the composer; the helpers are idempotent so a signature
	// already present in the draft isn't duplicated. The signed bodies are what
	// we both send and persist, so the stored record matches what went out.
	const signature = await getUserEmailSignature(user.id);
	const signedHtml = appendSignatureHtml(input.html, signature);
	const signedText = appendSignatureText(input.text, signature);

	const r = await sendReply({
		smtpHost: row.smtpHost!,
		smtpPort: row.smtpPort!,
		smtpSecure: row.smtpSecure!,
		emailAddress: row.emailAddress!,
		displayName: me?.fullName ?? undefined,
		encryptedPassword: row.encryptedPassword!,
		encryptionIv: row.encryptionIv!,
		encryptionAuthTag: row.encryptionAuthTag!,
		to: row.fromAddress,
		subject: input.subject,
		text: signedText,
		html: signedHtml,
		// We don't store the recipient's raw Message-ID separately; thread_id
		// is the RFC 822 message-id we extracted at parse time, which lines
		// up well enough for In-Reply-To threading.
		inReplyTo: row.threadId,
		threadId: row.threadId,
	});

	if (!r.sent) {
		logger.warn({ messageId: input.messageId, err: r.error }, 'sendReplyAction: SMTP failed');
		return { ok: false, error: r.error ?? 'Send failed' };
	}

	await db
		.update(inboxMessages)
		.set({
			aiStatus: 'sent',
			aiDraftSubject: input.subject,
			aiDraftHtml: signedHtml,
			aiDraftText: signedText,
			status: 'triaged',
			triagedAt: new Date().toISOString(),
			sentMessageId: r.messageId ?? null,
			sentAt: new Date().toISOString(),
		})
		.where(eq(inboxMessages.id, input.messageId));

	revalidatePath('/inbox');
	revalidatePath('/organizer/inbox');
	revalidatePath(`/inbox/${input.messageId}`);
	revalidatePath(`/organizer/inbox/${input.messageId}`);
	return { ok: true, sentMessageId: r.messageId };
}
