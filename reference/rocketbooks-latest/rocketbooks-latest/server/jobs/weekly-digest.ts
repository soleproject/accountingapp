import { inngest } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { isDemoOrg } from '@/lib/auth/demo';
import { buildWeeklyDigest } from '@/lib/digest/build-weekly-digest';
import { sendTransactionalEmail } from '@/lib/email/resend';

/**
 * Per-org weekly digest. Fired by the alerts-weekly cron fan-out for orgs whose
 * owner has opted in. Re-checks opt-in (defense), builds the digest from the
 * action-card worklist, and emails the owner. Fire-and-forget send (never
 * throws; no-ops if RESEND_API_KEY is unset). Retried; per-org concurrency.
 */
export const weeklyDigest = inngest.createFunction(
  {
    id: 'weekly-digest',
    concurrency: { limit: 5, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'digest/weekly.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId } = event.data as { organizationId: string };
    if (!organizationId || isDemoOrg(organizationId)) return { skipped: true, reason: 'no_input_or_demo' };

    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, ownerUserId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org) return { skipped: true, reason: 'no_org' };

    const [owner] = await db
      .select({ email: users.email, optIn: users.weeklyDigestOptInAt })
      .from(users)
      .where(and(eq(users.id, org.ownerUserId), eq(users.isActive, true)))
      .limit(1);
    if (!owner?.email || !owner.optIn) return { skipped: true, reason: 'not_opted_in' };

    const digest = await step.run('build', () => buildWeeklyDigest(organizationId, org.ownerUserId, org.name));

    const result = await step.run('send', () =>
      sendTransactionalEmail({
        to: owner.email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
        brandForOrgId: organizationId,
        usage: { userId: org.ownerUserId, orgId: organizationId, actor: 'system', feature: 'weekly-digest' },
      }),
    );

    logger.info(
      { organizationId, sent: result.sent, skipped: result.skipped, cards: digest.cardCount },
      'weekly-digest: complete',
    );
    return { organizationId, sent: result.sent, cards: digest.cardCount };
  },
);
