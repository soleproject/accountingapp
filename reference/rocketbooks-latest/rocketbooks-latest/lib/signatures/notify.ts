import 'server-only';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { sendTransactionalSms } from '@/lib/sms/twilio';
import type { UsageCtx } from '@/lib/ai/usage';
import { signingUrl } from './tokens';
import type { Recipient } from './store';

export type DeliveryChannel = 'email' | 'sms' | 'link';

export interface RecipientLink {
  recipientId: string;
  name: string;
  email: string;
  url: string;
  emailed: boolean;
  smsed: boolean;
}

/**
 * Deliver signing invites for each recipient over the chosen channels and
 * always return the raw link (so the owner can copy/hand it off). Email/SMS are
 * env-guarded no-ops when their keys aren't set, so this never throws.
 */
export async function sendInvites(args: {
  senderName: string;
  documentTitle: string;
  message: string;
  recipients: Recipient[];
  channels: DeliveryChannel[];
  /** Optional cost-tracking context, applied to each email/SMS sent. */
  usage?: UsageCtx;
}): Promise<RecipientLink[]> {
  const wantEmail = args.channels.includes('email');
  const wantSms = args.channels.includes('sms');
  const out: RecipientLink[] = [];

  for (const r of args.recipients) {
    const url = signingUrl(r.token);
    let emailed = false;
    let smsed = false;

    if (wantEmail && r.email) {
      const res = await sendTransactionalEmail({
        to: r.email,
        subject: `${args.senderName} requests your signature: ${args.documentTitle}`,
        text:
          `Hi ${r.name || 'there'},\n\n${args.senderName} has requested your signature on "${args.documentTitle}".` +
          `${args.message ? `\n\n${args.message}` : ''}\n\nReview and sign here:\n${url}\n\n` +
          `This link is unique to you — please don't forward it.`,
        html:
          `<p>Hi ${escapeHtml(r.name || 'there')},</p>` +
          `<p><strong>${escapeHtml(args.senderName)}</strong> has requested your signature on "<strong>${escapeHtml(args.documentTitle)}</strong>".</p>` +
          `${args.message ? `<p>${escapeHtml(args.message)}</p>` : ''}` +
          `<p><a href="${url}">Review &amp; sign</a></p>` +
          `<p style="color:#888;font-size:12px">This link is unique to you — please don't forward it.</p>`,
        ...(args.usage ? { usage: args.usage } : {}),
      });
      emailed = res.sent;
    }

    if (wantSms && r.phone) {
      const res = await sendTransactionalSms({
        to: r.phone,
        body: `${args.senderName} requests your signature on "${args.documentTitle}". Review & sign: ${url}`,
        ...(args.usage ? { usage: args.usage } : {}),
      });
      smsed = res.sent;
    }

    out.push({ recipientId: r.id, name: r.name, email: r.email, url, emailed, smsed });
  }

  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
