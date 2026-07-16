import 'server-only';
import nodemailer from 'nodemailer';
import { logger } from '@/lib/logger';
import { decryptSecret } from './crypto';

/**
 * Send a reply via the account's stored SMTP credentials.
 *
 * Threading: we set In-Reply-To and References headers using the
 * original Message-ID so the reply lands in the same thread in the
 * recipient's mail client. The original Message-ID we use here comes
 * from the inbox_messages row's external_id, which is structured as
 * `acct:<id>:<uidvalidity>:<uid>` for IMAP-sourced rows — NOT the
 * RFC 822 Message-ID itself. For threading to land cleanly we'd need
 * the original Message-ID stored alongside. v1 falls back to thread_id
 * (which IS the RFC 822 root Message-ID we extracted at parse time),
 * so threading is correct for replies in existing threads, and only
 * imperfect for first-touch replies (which is fine — those are starting
 * a new thread anyway).
 *
 * Known v1 limitation: we don't IMAP APPEND the sent message to the
 * provider's Sent folder. Gmail's SMTP auto-saves to Sent; Yahoo /
 * iCloud may not. Surfaced in UI as a soft warning.
 */

export interface SendReplyInput {
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
	emailAddress: string;
	displayName?: string;
	encryptedPassword: string;
	encryptionIv: string;
	encryptionAuthTag: string;

	to: string;
	subject: string;
	text: string;
	html: string;
	/** RFC 822 Message-ID of the message we're replying to (no <>). */
	inReplyTo: string | null;
	/** Thread root Message-ID we extracted earlier — used for References. */
	threadId: string | null;
	/** Optional attachments (Resend shape: filename + base64 content). */
	attachments?: Array<{ filename: string; content: string }>;
	/** Optional Reply-To override. */
	replyTo?: string;
}

export interface SendReplyResult {
	sent: boolean;
	messageId?: string;
	error?: string;
}

const TIMEOUT_MS = 20_000;

function wrapMessageId(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim().replace(/[<>]/g, '');
	if (!trimmed) return undefined;
	return `<${trimmed}>`;
}

export async function sendReply(input: SendReplyInput): Promise<SendReplyResult> {
	const password = decryptSecret({
		ciphertext: input.encryptedPassword,
		iv: input.encryptionIv,
		authTag: input.encryptionAuthTag,
	});

	const transport = nodemailer.createTransport({
		host: input.smtpHost,
		port: input.smtpPort,
		secure: input.smtpSecure,
		auth: { user: input.emailAddress, pass: password },
		connectionTimeout: TIMEOUT_MS,
		greetingTimeout: TIMEOUT_MS,
		socketTimeout: TIMEOUT_MS,
	});

	const inReplyTo = wrapMessageId(input.inReplyTo ?? input.threadId);
	// References should include the thread root + any ancestors. We don't
	// store the full chain today, so include thread root + the immediate
	// parent (which may be the same).
	const referencesParts = [wrapMessageId(input.threadId), wrapMessageId(input.inReplyTo)].filter(
		(s): s is string => !!s,
	);
	// De-dup while preserving order — Set won't help if values are identical.
	const references = Array.from(new Set(referencesParts)).join(' ');

	const from = input.displayName
		? `"${input.displayName.replace(/"/g, '\\"')}" <${input.emailAddress}>`
		: input.emailAddress;

	try {
		const info = await transport.sendMail({
			from,
			to: input.to,
			...(input.replyTo ? { replyTo: input.replyTo } : {}),
			subject: input.subject,
			text: input.text,
			html: input.html,
			...(input.attachments?.length
				? { attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' as const })) }
				: {}),
			headers: {
				...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}),
				...(references ? { References: references } : {}),
			},
		});
		// nodemailer returns messageId wrapped in <>; strip for storage so
		// it matches the format we keep in inbox_messages.thread_id.
		const messageId = info.messageId ? info.messageId.replace(/[<>]/g, '') : undefined;
		return { sent: true, messageId };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ to: input.to, smtpHost: input.smtpHost, err: msg }, 'send-reply failed');
		return { sent: false, error: msg };
	} finally {
		transport.close();
	}
}
