import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema/schema';
import { sendTransactionalEmail, isResendConfigured } from '@/lib/email/resend';
import { logger } from '@/lib/logger';

/**
 * Send a user-initiated email, preferring the user's own LINKED mailbox.
 *
 * When the user has connected an email account, we send through their SMTP so
 * the message comes from their real address, replies land in their inbox, and
 * no Resend domain verification is needed. If they haven't linked one (or the
 * linked send fails), we fall back to the Resend transactional sender (brand
 * domain). System emails with no user behind them should call Resend directly
 * instead of this helper.
 */
export interface SendAsUserArgs {
  userId: string;
  to: string;
  subject: string;
  text: string;
  /** Optional HTML; derived from `text` when omitted. */
  html?: string;
  attachments?: Array<{ filename: string; content: string }>;
  replyTo?: string;
}

export interface SendAsUserResult {
  sent: boolean;
  /** Which transport actually sent it. */
  via?: 'linked' | 'resend';
  messageId?: string;
  error?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function textToHtml(text: string): string {
  return `<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

export async function sendAsUser(args: SendAsUserArgs): Promise<SendAsUserResult> {
  const html = args.html ?? textToHtml(args.text);

  // 1) Detect linked mailbox presence without bundling Node SMTP libraries into
  // the Cloudflare Worker. User-initiated sends currently go through the Resend
  // fallback on the Worker runtime; the linked-mailbox SMTP path remains in
  // send-reply.ts for a future Node/background lane.
  const [acct] = await db
    .select({ id: emailAccounts.id, emailAddress: emailAccounts.emailAddress })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, args.userId), eq(emailAccounts.isActive, true)))
    .orderBy(desc(emailAccounts.updatedAt))
    .limit(1);

  if (acct) {
    logger.info({ userId: args.userId }, 'sendAsUser: linked SMTP send deferred on Cloudflare — using Resend fallback');
  }

  // 2) Fallback: Resend transactional (brand domain).
  if (!isResendConfigured()) {
    return {
      sent: false,
      error: acct
        ? 'Could not send through your linked email, and no fallback email service is configured.'
        : 'No email connected. Link your email under Settings → Email to send (or configure a fallback sender).',
    };
  }
  const r = await sendTransactionalEmail({ to: args.to, subject: args.subject, text: args.text, html, attachments: args.attachments, ...(args.replyTo ? { replyTo: args.replyTo } : {}), usage: { userId: args.userId, orgId: null, actor: 'user', feature: 'send-as-user' } });
  return r.sent ? { sent: true, via: 'resend', messageId: r.id } : { sent: false, error: r.error };
}
