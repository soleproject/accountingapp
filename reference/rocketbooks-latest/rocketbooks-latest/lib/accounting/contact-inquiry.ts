import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users, aiClientOutreach } from '@/db/schema/schema';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { inboundConfigured, outreachReplyToAddress } from '@/lib/email/inbound-token';
import { findUnknownContactGroups } from './unknown-contact';

const COOLDOWN_HOURS = 24;
const money = (n: number) =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface ContactInquiryResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  groups?: number;
  txns?: number;
  error?: string;
}

/**
 * Email the client about recent transactions whose contact is unknown, asking
 * them to reply with who each party is. Stores the referenced txn IDs on the
 * outreach row (context) + a tokenized reply-to, so the inbound reply can be
 * applied to exactly those transactions. Inert unless inbound email is wired up.
 */
export async function sendContactInquiry(args: {
  orgId: string;
  days?: number;
  force?: boolean;
}): Promise<ContactInquiryResult> {
  const { orgId } = args;
  // Pointless to ask people to "reply" if replies can't route back.
  if (!inboundConfigured()) return { ok: true, skipped: true, reason: 'inbound_not_configured' };

  if (!args.force) {
    const [recent] = await db
      .select({ last: aiClientOutreach.lastContactAt })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          eq(aiClientOutreach.issueType, 'contact_inquiry'),
          eq(aiClientOutreach.status, 'sent'),
          sql`${aiClientOutreach.lastContactAt} > now() - interval '${sql.raw(String(COOLDOWN_HOURS))} hours'`,
        ),
      )
      .orderBy(desc(aiClientOutreach.lastContactAt))
      .limit(1);
    if (recent?.last) return { ok: true, skipped: true, reason: 'cooldown' };
  }

  const groups = await findUnknownContactGroups(orgId, args.days ?? 5);
  if (groups.length === 0) return { ok: true, skipped: true, reason: 'no_unknown_contacts' };

  const [org] = await db
    .select({ name: organizations.name, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.ownerUserId) return { ok: false, error: 'No org owner' };
  const [owner] = await db
    .select({ email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, org.ownerUserId))
    .limit(1);
  if (!owner?.email) return { ok: false, error: 'Owner has no email' };

  const business = org.name?.trim() || 'your bookkeeper';
  const firstName = owner.fullName?.trim().split(/\s+/)[0] || 'there';
  const allTxnIds = groups.flatMap((g) => g.txnIds);
  const outreachId = randomUUID();
  const replyTo = outreachReplyToAddress(outreachId) ?? undefined;
  const subject = 'A few new transactions — who are these?';

  const lines = groups
    .map((g) => `• ${g.merchant} — ${g.sample.date ?? ''} — ${money(Number(g.sample.amount ?? 0))}${g.count > 1 ? ` (and ${g.count - 1} more)` : ''}`)
    .join('\n');
  const body = [
    `Hi ${firstName},`,
    '',
    `We spotted ${allTxnIds.length} recent transaction(s) where we don't recognize the other party. Could you reply to this email and tell us who each one is and what it was for? A line each is perfect — e.g. "Acme is our main supplier, that was raw materials."`,
    '',
    lines,
    '',
    `Just reply here and we'll take care of the rest. Thanks!`,
    `— ${business}`,
  ].join('\n');

  let sent = false;
  try {
    const r = await sendTransactionalEmail({
      to: owner.email,
      subject,
      text: body,
      fromName: business,
      replyTo,
      brandForOrgId: orgId,
      usage: { userId: org.ownerUserId, orgId, actor: 'system', feature: 'contact_inquiry' },
    });
    sent = r.sent;
  } catch (e) {
    console.error('contact-inquiry: send failed', e);
  }

  try {
    await db.insert(aiClientOutreach).values({
      id: outreachId,
      organizationId: orgId,
      issueType: 'contact_inquiry',
      channel: 'email',
      status: sent ? 'sent' : 'failed',
      targetType: 'client_owner',
      lastMessageSubject: subject,
      lastMessageBody: body,
      lastContactAt: new Date().toISOString(),
      attempts: 1,
      createdByUserId: org.ownerUserId,
      context: {
        transactionIds: allTxnIds,
        groups: groups.map((g) => ({ merchant: g.merchant, contactId: g.contactId, txnIds: g.txnIds })),
      },
    });
  } catch (e) {
    console.error('contact-inquiry: log failed', e);
  }

  if (!sent) return { ok: false, error: 'send failed', groups: groups.length, txns: allTxnIds.length };
  return { ok: true, groups: groups.length, txns: allTxnIds.length };
}
