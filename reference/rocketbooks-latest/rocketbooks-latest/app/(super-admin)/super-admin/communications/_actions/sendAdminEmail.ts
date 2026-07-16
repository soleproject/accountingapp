'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { adminCommunications } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { sendTransactionalEmail, isResendConfigured } from '@/lib/email/resend';
import { logger } from '@/lib/logger';

// Simple RFC 5322-ish check — good enough to reject obvious junk in the
// form. Resend will reject anything malformed on its end too.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Convert HTML body to a plain-text fallback so every send carries both
 * representations. Cheap: strips tags, decodes a couple of common
 * entities, collapses whitespace. Not perfect — Phase 2 can swap in a
 * proper HTML-to-text lib if/when we care about formatting fidelity.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Manual send from /super-admin/communications. Re-asserts SuperAdmin
 * (defense in depth — server actions are routable independently of the
 * layout that normally gates the page). Always writes a row to
 * admin_communications regardless of outcome so the UI can show
 * "skipped — RESEND_API_KEY not configured" alongside real sends/failures.
 */
export async function sendAdminEmailAction(formData: FormData): Promise<void> {
  const user = await requireSession();
  if (!(await isSuperAdmin())) throw new Error('forbidden');

  const toEmail = String(formData.get('toEmail') ?? '').trim();
  const replyToRaw = String(formData.get('replyTo') ?? '').trim();
  const subject = String(formData.get('subject') ?? '').trim();
  const bodyHtml = String(formData.get('bodyHtml') ?? '');
  // Optional explicit text override; otherwise derive from HTML.
  const bodyTextOverride = String(formData.get('bodyText') ?? '').trim();

  if (!toEmail) throw new Error('Recipient email is required');
  if (!EMAIL_RE.test(toEmail)) throw new Error('Recipient email looks invalid');
  if (replyToRaw && !EMAIL_RE.test(replyToRaw)) throw new Error('Reply-to email looks invalid');
  if (!subject) throw new Error('Subject is required');
  if (!bodyHtml.trim()) throw new Error('Body is required');

  const replyTo = replyToRaw || user.email || undefined;
  const bodyText = bodyTextOverride || htmlToText(bodyHtml);
  const id = randomUUID();

  if (!isResendConfigured()) {
    await db.insert(adminCommunications).values({
      id,
      sentByUserId: user.id,
      toEmail,
      replyTo: replyTo ?? null,
      subject,
      bodyHtml,
      bodyText,
      status: 'skipped',
      error: 'RESEND_API_KEY not configured',
    });
    revalidatePath('/super-admin/communications');
    redirect(`/super-admin/communications/${id}`);
  }

  const result = await sendTransactionalEmail({
    to: toEmail,
    subject,
    html: bodyHtml,
    text: bodyText,
    replyTo,
    usage: { userId: user.id, orgId: null, actor: 'super-admin', feature: 'admin-email' },
  });

  await db.insert(adminCommunications).values({
    id,
    sentByUserId: user.id,
    toEmail,
    replyTo: replyTo ?? null,
    subject,
    bodyHtml,
    bodyText,
    status: result.sent ? 'sent' : 'failed',
    providerMessageId: result.id ?? null,
    error: result.sent ? null : (result.error ?? 'unknown'),
  });

  if (!result.sent) {
    logger.warn({ toEmail, subject, err: result.error }, 'admin manual email failed');
  }

  revalidatePath('/super-admin/communications');
  redirect(`/super-admin/communications/${id}`);
}
