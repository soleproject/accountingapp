import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users, aiClientOutreach, transactionSubstantiation } from '@/db/schema/schema';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { inboundConfigured, outreachReplyToAddress } from '@/lib/email/inbound-token';
import { findTxnsNeedingSubstantiation } from './substantiation';
import { specFor, askText, autoFieldValues } from './substantiation-types';

const COOLDOWN_HOURS = 24;
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
/** Absolute URL to the IRS-documentation page the "add them all" button opens. */
function substantiationUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.rocketbooks.ai').replace(/\/+$/, '');
  return `${base}/substantiation`;
}

export interface SubstReqResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  items?: number;
  error?: string;
}

/**
 * Email the client for the IRS documentation required on recent transactions
 * (meals/travel/gifts/etc.). Tracks each as a substantiation record (status
 * 'requested') and stores the referenced txns on the outreach context so the
 * reply can be applied. Tokenized reply-to → inbound webhook → reply processor.
 * Inert unless inbound email is configured.
 */
export async function sendSubstantiationRequest(args: {
  orgId: string;
  days?: number;
  force?: boolean;
  overrideRecipients?: string[];
}): Promise<SubstReqResult> {
  const { orgId } = args;
  if (!inboundConfigured()) return { ok: true, skipped: true, reason: 'inbound_not_configured' };

  if (!args.force) {
    const [recent] = await db
      .select({ last: aiClientOutreach.lastContactAt })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          eq(aiClientOutreach.issueType, 'substantiation_request'),
          eq(aiClientOutreach.status, 'sent'),
          sql`${aiClientOutreach.lastContactAt} > now() - interval '${sql.raw(String(COOLDOWN_HOURS))} hours'`,
        ),
      )
      .orderBy(desc(aiClientOutreach.lastContactAt))
      .limit(1);
    if (recent?.last) return { ok: true, skipped: true, reason: 'cooldown' };
  }

  const needing = await findTxnsNeedingSubstantiation(orgId, args.days ?? 7);
  if (needing.length === 0) return { ok: true, skipped: true, reason: 'none_needed' };

  const [org] = await db.select({ name: organizations.name, ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org?.ownerUserId) return { ok: false, error: 'No org owner' };
  const [owner] = await db.select({ email: users.email, fullName: users.fullName }).from(users).where(eq(users.id, org.ownerUserId)).limit(1);
  const emailTo = args.overrideRecipients?.length ? args.overrideRecipients : owner?.email ? [owner.email] : [];
  if (emailTo.length === 0) return { ok: false, error: 'Owner has no email' };

  const business = org.name?.trim() || 'your bookkeeper';
  const firstName = owner?.fullName?.trim().split(/\s+/)[0] || 'there';
  const outreachId = randomUUID();
  const replyTo = outreachReplyToAddress(outreachId) ?? undefined;
  const subject = 'A few transactions need IRS documentation';

  // Show ONLY the first (oldest) transaction. If there are more, the client can
  // reply about this one, or open the page to provide docs for all of them at once.
  const total = needing.length;
  const first = needing[0];
  const firstAsk = askText(specFor(first.docType));
  const oneLine = `• ${first.date ?? ''}  ${money(Number(first.amount ?? 0))}  ${first.description ?? ''}\n   Please provide: ${firstAsk}`;
  const docsUrl = substantiationUrl();

  const intro =
    total > 1
      ? `The IRS requires a bit of extra documentation to keep these deductible. Could you reply with the details for the transaction below?`
      : `The IRS requires a bit of extra documentation for this recent transaction to keep it deductible. Could you reply with the details?`;
  const moreText =
    total > 1
      ? `\n\nThis is 1 of ${total} transactions that need documentation. Reply here with the details for this one — or add them all at once:\n${docsUrl}`
      : '';
  const body = [
    `Hi ${firstName},`,
    '',
    intro,
    '',
    oneLine,
    moreText,
    '',
    `Just reply here and we'll file it with the transaction. Thanks!`,
    `— ${business}`,
  ].join('\n');

  const htmlBody = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;font-size:15px;line-height:1.5">
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${escapeHtml(intro)}</p>
    <div style="border:1px solid #e4e4e7;border-radius:8px;padding:12px 16px;margin:14px 0">
      <div style="font-weight:600">${escapeHtml(first.date ?? '')} &nbsp;&middot;&nbsp; ${money(Number(first.amount ?? 0))} &nbsp;&middot;&nbsp; ${escapeHtml(first.description ?? '')}</div>
      <div style="color:#52525b;font-size:13px;margin-top:6px">Please provide: ${escapeHtml(firstAsk)}</div>
    </div>
    ${
      total > 1
        ? `<p style="color:#52525b">This is <strong>1 of ${total}</strong> transactions that need documentation. Reply here with the details for this one — or add them all at once:</p>
    <p><a href="${docsUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Provide documentation for all ${total}</a></p>`
        : ''
    }
    <p>Just reply here and we'll file it with the transaction. Thanks!</p>
    <p style="color:#71717a">— ${escapeHtml(business)}</p>
  </div>`;

  let sent = false;
  try {
    const r = await sendTransactionalEmail({
      to: emailTo,
      subject,
      text: body,
      html: htmlBody,
      fromName: business,
      brandForOrgId: orgId,
      replyTo,
      usage: { userId: org.ownerUserId, orgId, actor: 'system', feature: 'substantiation_request' },
    });
    sent = r.sent;
  } catch (e) {
    console.error('substantiation-outreach: send failed', e);
  }

  // Track each as requested (idempotent on the unique org+txn index).
  try {
    const now = new Date().toISOString();
    await db
      .insert(transactionSubstantiation)
      .values(needing.map((n) => ({
        id: randomUUID(),
        organizationId: orgId,
        transactionId: n.txnId,
        docType: n.docType,
        status: 'requested',
        requestedAt: now,
        // Prefill what we already know (amount/date/merchant) so we never re-ask.
        fields: autoFieldValues(specFor(n.docType), { amount: n.amount, date: n.date, merchant: n.description }),
      })))
      .onConflictDoNothing();
  } catch (e) {
    console.error('substantiation-outreach: record insert failed', e);
  }

  try {
    await db.insert(aiClientOutreach).values({
      id: outreachId,
      organizationId: orgId,
      issueType: 'substantiation_request',
      channel: 'email',
      status: sent ? 'sent' : 'failed',
      targetType: 'client_owner',
      lastMessageSubject: subject,
      lastMessageBody: body,
      lastContactAt: new Date().toISOString(),
      attempts: 1,
      createdByUserId: org.ownerUserId,
      context: { items: needing.map((n) => ({ transactionId: n.txnId, docType: n.docType })) },
    });
  } catch (e) {
    console.error('substantiation-outreach: log failed', e);
  }

  if (!sent) return { ok: false, error: 'send failed', items: needing.length };
  return { ok: true, items: needing.length };
}
