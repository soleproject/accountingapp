import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, organizations, users, aiClientOutreach } from '@/db/schema/schema';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { sendTransactionalSms } from '@/lib/sms/twilio';
import { getFirmBaseUrlForOrg } from '@/lib/enterprise/firm-branding';

/**
 * Proactive "we need your input" outreach to the client (org owner) about
 * transactions sitting in the review queue — the system reaching out to identify
 * what ambiguous transactions were. Email always; SMS too when the owner opted
 * in. Logged to ai_client_outreach (issueType='review_request') with a cooldown
 * so we never spam. Best-effort, never throws. Mirrors lib/enterprise/ar-collections.ts.
 */

const COOLDOWN_HOURS = 24;

export async function countPendingReview(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, orgId),
        or(eq(transactions.reviewed, false), isNull(transactions.reviewed)),
      ),
    );
  return row?.n ?? 0;
}

export interface ReviewRequestResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  count?: number;
  channels?: string[];
  error?: string;
}

export async function sendClientReviewRequest(args: {
  orgId: string;
  triggeredByUserId?: string;
  force?: boolean;
  /** Skip if fewer than this many pending items (automatic reminders pass >1 to avoid nagging). */
  minPending?: number;
  /** Send the email to these addresses only + skip SMS (test sends). */
  overrideRecipients?: string[];
}): Promise<ReviewRequestResult> {
  const { orgId } = args;
  const count = await countPendingReview(orgId);
  if (count === 0) return { ok: true, skipped: true, reason: 'nothing_to_review', count: 0 };
  if (args.minPending && count < args.minPending) {
    return { ok: true, skipped: true, reason: 'below_threshold', count };
  }

  // Cooldown — don't re-nudge within COOLDOWN_HOURS unless forced.
  if (!args.force) {
    const [recent] = await db
      .select({ last: aiClientOutreach.lastContactAt })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          eq(aiClientOutreach.issueType, 'review_request'),
          eq(aiClientOutreach.status, 'sent'),
          sql`${aiClientOutreach.lastContactAt} > now() - (${COOLDOWN_HOURS} || ' hours')::interval`,
        ),
      )
      .orderBy(sql`${aiClientOutreach.lastContactAt} desc`)
      .limit(1);
    if (recent?.last) {
      const hrs = Math.max(1, Math.round((Date.now() - new Date(recent.last).getTime()) / 3_600_000));
      return { ok: true, skipped: true, reason: 'cooldown', count, error: `Already requested ${hrs}h ago` };
    }
  }

  const [org] = await db
    .select({ name: organizations.name, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.ownerUserId) return { ok: false, error: 'No org owner to contact', count };

  const [owner] = await db
    .select({ email: users.email, phone: users.phone, smsOptInAt: users.smsOptInAt, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, org.ownerUserId))
    .limit(1);
  // Test sends route the email to overrideRecipients only (and skip SMS).
  const emailTargets = args.overrideRecipients?.length
    ? [...new Set(args.overrideRecipients.map((e) => e.toLowerCase()))]
    : owner?.email
      ? [owner.email]
      : [];
  if (emailTargets.length === 0 && !(owner?.phone && owner?.smsOptInAt)) {
    return { ok: false, error: 'Owner has no email or phone on file', count };
  }

  const business = org.name?.trim() || 'your bookkeeper';
  const firstName = owner?.fullName?.trim().split(/\s+/)[0] || 'there';
  const link = `${await getFirmBaseUrlForOrg(orgId)}/transactions?filter=to_review`;
  const noun = count === 1 ? 'transaction' : 'transactions';
  const subject = `${count} ${noun} need your input`;
  const body = [
    `Hi ${firstName},`,
    '',
    `Your books have ${count} ${noun} we need a quick hand with — just confirming what they were so everything lands in the right category.`,
    '',
    `It only takes a couple of minutes: ${link}`,
    '',
    'Thanks!',
    `— ${business}`,
  ].join('\n');

  const channels: string[] = [];
  let anySent = false;

  if (emailTargets.length) {
    try {
      const r = await sendTransactionalEmail({
        to: emailTargets,
        subject,
        text: body,
        fromName: business,
        brandForOrgId: orgId,
        usage: { userId: args.triggeredByUserId ?? '', orgId, actor: 'system', feature: 'review_request_email' },
      });
      if (r.sent) {
        channels.push('email');
        anySent = true;
      }
    } catch (e) {
      console.error('review-outreach: email send failed', e);
    }
  }

  if (!args.overrideRecipients?.length && owner?.phone && owner?.smsOptInAt) {
    try {
      const r = await sendTransactionalSms({
        to: owner.phone,
        body: `${business}: ${count} ${noun} need your quick input to finish your books — ${link}`,
        usage: { userId: args.triggeredByUserId ?? '', orgId, actor: 'system', feature: 'review_request_sms' },
      });
      if (r.sent) {
        channels.push('sms');
        anySent = true;
      }
    } catch (e) {
      console.error('review-outreach: sms send failed', e);
    }
  }

  try {
    await db.insert(aiClientOutreach).values({
      id: randomUUID(),
      organizationId: orgId,
      issueType: 'review_request',
      channel: channels.join('+') || null,
      status: anySent ? 'sent' : 'failed',
      targetType: 'client_owner',
      lastMessageSubject: subject,
      lastMessageBody: body,
      lastContactAt: new Date().toISOString(),
      attempts: 1,
      createdByUserId: args.triggeredByUserId ?? null,
    });
  } catch (e) {
    console.error('review-outreach: log failed', e);
  }

  if (!anySent) {
    return { ok: false, error: 'Could not reach the client (check their email / SMS opt-in)', count };
  }
  return { ok: true, count, channels };
}
