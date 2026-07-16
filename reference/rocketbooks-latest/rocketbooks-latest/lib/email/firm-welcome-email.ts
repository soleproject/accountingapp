import 'server-only';
import { sendTransactionalEmail, type SendEmailResult } from './resend';
import type { UsageCtx } from '@/lib/ai/usage';

export interface FirmWelcomeEmailArgs {
  to: string;
  fullName: string;
  firmName: string;
  appUrl: string;
  /** Where the CTA points. Defaults to the enterprise dashboard. */
  dashboardPath?: string;
  /** Optional cost-tracking context for the unified usage ledger. */
  usage?: UsageCtx;
}

export function renderFirmWelcomeEmail(
  args: Omit<FirmWelcomeEmailArgs, 'to'>,
): { subject: string; text: string; html: string } {
  const base = args.appUrl.replace(/\/+$/, '');
  const dashboardUrl = `${base}${args.dashboardPath ?? '/enterprise/dashboard'}`;
  const subject = `Welcome to RocketBooks, ${firstName(args.fullName)} — your firm is live`;

  const text =
    `Hi ${args.fullName},\n\n` +
    `Welcome to RocketBooks. Your firm account for ${args.firmName} is set up and ready.\n\n` +
    `Open your firm dashboard: ${dashboardUrl}\n\n` +
    `What's next:\n` +
    `  1. Finish your firm setup — branding, pricing, and client experience.\n` +
    `  2. Add your clients (or share your invite link so they self-onboard).\n` +
    `  3. Let the AI handle the busywork — categorization, reconciliation, and client follow-ups.\n\n` +
    `You're on the Regular plan: no monthly platform fee, and you earn a 20% referral share for every paying client. You can switch to a Private Label or Certified Partner plan any time from your dashboard.\n\n` +
    `Need a hand? Just reply to this email.\n\n` +
    `— The RocketBooks team`;

  const html =
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5">` +
    `<p>Hi ${escapeHtml(args.fullName)},</p>` +
    `<p>Welcome to <strong>RocketBooks</strong>. Your firm account for <strong>${escapeHtml(args.firmName)}</strong> is set up and ready.</p>` +
    `<p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Open your firm dashboard</a></p>` +
    `<p><strong>What's next:</strong></p>` +
    `<ol>` +
    `<li>Finish your firm setup &mdash; branding, pricing, and client experience.</li>` +
    `<li>Add your clients (or share your invite link so they self-onboard).</li>` +
    `<li>Let the AI handle the busywork &mdash; categorization, reconciliation, and client follow-ups.</li>` +
    `</ol>` +
    `<p>You're on the <strong>Regular</strong> plan: no monthly platform fee, and you earn a 20% referral share for every paying client. You can switch to a Private Label or Certified Partner plan any time from your dashboard.</p>` +
    `<p>Need a hand? Just reply to this email.</p>` +
    `<p>&mdash; The RocketBooks team</p>` +
    `</body></html>`;

  return { subject, text, html };
}

export async function sendFirmWelcomeEmail(args: FirmWelcomeEmailArgs): Promise<SendEmailResult> {
  const rendered = renderFirmWelcomeEmail(args);
  return sendTransactionalEmail({ to: args.to, ...rendered, ...(args.usage ? { usage: args.usage } : {}) });
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
