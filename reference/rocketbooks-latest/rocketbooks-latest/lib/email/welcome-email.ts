import 'server-only';
import { sendTransactionalEmail, type SendEmailResult } from './resend';
import type { UsageCtx } from '@/lib/ai/usage';

export interface WelcomeEmailArgs {
  to: string;
  fullName: string;
  companyName: string;
  appUrl: string;
  loginPath?: string;
  /** Optional cost-tracking context for the unified usage ledger. */
  usage?: UsageCtx;
}

export function renderWelcomeEmail(args: Omit<WelcomeEmailArgs, 'to'>): { subject: string; text: string; html: string } {
  const loginUrl = `${args.appUrl.replace(/\/+$/, '')}${args.loginPath ?? '/login'}`;
  const subject = `Welcome to RocketBooks, ${firstName(args.fullName)}`;

  const text =
    `Hi ${args.fullName},\n\n` +
    `Welcome to RocketBooks — your 7-day free trial for ${args.companyName} is active.\n\n` +
    `Sign in any time: ${loginUrl}\n\n` +
    `What's next:\n` +
    `  1. Connect your bank accounts so we can start categorizing transactions.\n` +
    `  2. Tell us about your business so the AI understands your books.\n` +
    `  3. Sit back — RocketBooks imports historical data and keeps your books current.\n\n` +
    `Need a hand? Just reply to this email.\n\n` +
    `— The RocketBooks team`;

  const html =
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5">` +
    `<p>Hi ${escapeHtml(args.fullName)},</p>` +
    `<p>Welcome to <strong>RocketBooks</strong> — your 7-day free trial for <strong>${escapeHtml(args.companyName)}</strong> is active.</p>` +
    `<p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Sign in to RocketBooks</a></p>` +
    `<p><strong>What's next:</strong></p>` +
    `<ol>` +
    `<li>Connect your bank accounts so we can start categorizing transactions.</li>` +
    `<li>Tell us about your business so the AI understands your books.</li>` +
    `<li>Sit back &mdash; RocketBooks imports historical data and keeps your books current.</li>` +
    `</ol>` +
    `<p>Need a hand? Just reply to this email.</p>` +
    `<p>&mdash; The RocketBooks team</p>` +
    `</body></html>`;

  return { subject, text, html };
}

export async function sendWelcomeEmail(args: WelcomeEmailArgs): Promise<SendEmailResult> {
  const rendered = renderWelcomeEmail(args);
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
