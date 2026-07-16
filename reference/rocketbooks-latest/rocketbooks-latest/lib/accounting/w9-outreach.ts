import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, contacts, aiClientOutreach } from '@/db/schema/schema';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { inboundConfigured, outreachReplyToAddress } from '@/lib/email/inbound-token';

const COOLDOWN_HOURS = 24;

export interface W9ReqResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Email a vendor to collect their W-9 (legal name, TIN, tax classification) so
 * we can issue a 1099-NEC. Reuses the tokenized reply-to → inbound webhook →
 * reply processor (lib/accounting/w9-reply.ts) which files the TIN and flips the
 * contact's w9_status to 'on_file'. Inert unless inbound email is configured.
 */
export async function sendW9Request(args: {
  orgId: string;
  contactId: string;
  force?: boolean;
  overrideRecipients?: string[];
}): Promise<W9ReqResult> {
  const { orgId, contactId } = args;
  if (!inboundConfigured()) return { ok: true, skipped: true, reason: 'inbound_not_configured' };

  const [contact] = await db
    .select({ name: contacts.contactName, email: contacts.email, w9Status: contacts.w9Status })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!contact) return { ok: false, error: 'Contact not found' };

  const emailTo = args.overrideRecipients?.length ? args.overrideRecipients : contact.email ? [contact.email] : [];
  if (emailTo.length === 0) return { ok: false, error: 'Vendor has no email on file' };

  if (!args.force) {
    const [recent] = await db
      .select({ last: aiClientOutreach.lastContactAt })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          eq(aiClientOutreach.issueType, 'w9_request'),
          eq(aiClientOutreach.status, 'sent'),
          sql`${aiClientOutreach.context}->>'contactId' = ${contactId}`,
          sql`${aiClientOutreach.lastContactAt} > now() - interval '${sql.raw(String(COOLDOWN_HOURS))} hours'`,
        ),
      )
      .orderBy(desc(aiClientOutreach.lastContactAt))
      .limit(1);
    if (recent?.last) return { ok: true, skipped: true, reason: 'cooldown' };
  }

  const [org] = await db.select({ name: organizations.name, ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const business = org?.name?.trim() || 'your accounting team';
  const firstName = contact.name?.trim().split(/\s+/)[0] || 'there';
  const outreachId = randomUUID();
  const replyTo = outreachReplyToAddress(outreachId) ?? undefined;
  const subject = `W-9 request from ${business}`;

  const body = [
    `Hi ${firstName},`,
    '',
    `For our records and year-end 1099 reporting, could you reply to this email with your W-9 details? We just need:`,
    '',
    `• Legal name (and business name, if different)`,
    `• Taxpayer ID number — EIN or SSN`,
    `• Federal tax classification (sole proprietor, single-member LLC, partnership, S-corp, or C-corp)`,
    '',
    `Just reply here and we'll take care of the rest. Thank you!`,
    `— ${business}`,
  ].join('\n');

  let sent = false;
  try {
    const r = await sendTransactionalEmail({
      to: emailTo,
      subject,
      text: body,
      fromName: business,
      brandForOrgId: orgId,
      replyTo,
      usage: { userId: org?.ownerUserId ?? null, orgId, actor: 'system', feature: 'w9_request' },
    });
    sent = r.sent;
  } catch (e) {
    console.error('w9-outreach: send failed', e);
  }

  try {
    await db.insert(aiClientOutreach).values({
      id: outreachId,
      organizationId: orgId,
      issueType: 'w9_request',
      channel: 'email',
      status: sent ? 'sent' : 'failed',
      targetType: 'vendor',
      lastMessageSubject: subject,
      lastMessageBody: body,
      lastContactAt: new Date().toISOString(),
      attempts: 1,
      createdByUserId: org?.ownerUserId ?? null,
      context: { contactId },
    });
  } catch (e) {
    console.error('w9-outreach: log failed', e);
  }

  // Mark the vendor as requested (don't downgrade one already on file).
  if (sent && contact.w9Status !== 'on_file') {
    try {
      await db.update(contacts).set({ w9Status: 'requested', updatedAt: new Date().toISOString() }).where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)));
    } catch (e) {
      console.error('w9-outreach: status update failed', e);
    }
  }

  if (!sent) return { ok: false, error: 'send failed' };
  return { ok: true };
}

/**
 * Bulk: request W-9s from every 1099-eligible vendor that has an email and
 * isn't already on file. Returns how many were sent/skipped.
 */
export async function sendW9RequestsForEligible(orgId: string): Promise<{ sent: number; skipped: number; errors: number }> {
  const targets = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, orgId),
        eq(contacts.is1099Eligible, true),
        ne(contacts.w9Status, 'on_file'),
        sql`${contacts.email} is not null and ${contacts.email} <> ''`,
      ),
    );

  let sent = 0, skipped = 0, errors = 0;
  for (const t of targets) {
    const r = await sendW9Request({ orgId, contactId: t.id });
    if (r.ok && !r.skipped) sent++;
    else if (r.skipped) skipped++;
    else errors++;
  }
  return { sent, skipped, errors };
}
