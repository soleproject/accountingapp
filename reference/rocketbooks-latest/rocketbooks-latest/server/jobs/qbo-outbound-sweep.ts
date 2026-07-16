import 'server-only';
import { inngest, safeSend } from '@/lib/inngest';
import { db } from '@/db/client';
import { qboOutboundQueue } from '@/db/schema/schema';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

/**
 * Safety net for the outbound queue. The drain worker normally fires on
 * the qbo/outbound.enqueued event a server action emits after committing
 * the queue row. But that event can go missing:
 *
 *   - Inngest dev server was down when the action ran
 *   - The action crashed between commit and safeSend
 *   - A retry rescheduled the row for the future and the prior drain run
 *     ended before the new scheduled_at — nothing wakes it up
 *
 * Every 5 minutes we scan for realms that have at least one pending row
 * past its scheduled_at and fire one drain event per realm. The drain's
 * concurrency=1-per-realm setting means duplicate triggers harmlessly
 * queue behind any in-flight run.
 *
 * We do NOT touch 'failed' rows — those are permanent errors that need
 * either code changes or manual inspection.
 */
export const qboOutboundSweep = inngest.createFunction(
  {
    id: 'qbo-outbound-sweep',
    retries: 2,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    const realms = await step.run('find-realms-with-pending', async () => {
      const rows = await db
        .selectDistinct({ realmId: qboOutboundQueue.realmId })
        .from(qboOutboundQueue)
        .where(sql`${qboOutboundQueue.status} = 'pending' AND ${qboOutboundQueue.scheduledAt} <= now()`);
      return rows.map((r) => r.realmId);
    });

    if (realms.length === 0) return { fired: 0 };

    await step.run('fire-drain-events', async () => {
      for (const realmId of realms) {
        await safeSend({
          name: 'qbo/outbound.enqueued',
          data: { realmId },
        });
      }
    });

    logger.info({ realms: realms.length }, 'qbo outbound sweep fired drain events');
    return { fired: realms.length, realms };
  },
);
