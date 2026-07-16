import { inngest } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { detectDuplicatesBatch } from '@/lib/audit/duplicates';
import { runIntegritySweep } from '@/lib/audit/integrity';
import { runAnomalySweep } from '@/lib/audit/anomalies';
import { writeFindings } from '@/lib/audit/findings';

/**
 * Nightly books-correctness sweep for one org. Fired per-org by the
 * alerts-daily cron fan-out. Runs the heavy set-based duplicate re-scan and the
 * trial-balance/integrity sweep, persisting findings idempotently (the partial
 * unique index collapses repeats to one open row per subject). Flag-only —
 * nothing here mutates the books. Per-org concurrency so a manual trigger and
 * the cron don't double-run for the same org; retried.
 */
export const auditSweep = inngest.createFunction(
  {
    id: 'audit-sweep',
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'audit/sweep.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId } = event.data as { organizationId: string };
    if (!organizationId) return { skipped: true, reason: 'no_input' };

    const dupCount = await step.run('duplicates', async () => {
      const findings = await detectDuplicatesBatch(organizationId);
      return writeFindings(organizationId, findings);
    });

    const integrityCount = await step.run('integrity', async () => {
      const findings = await runIntegritySweep(organizationId);
      return writeFindings(organizationId, findings);
    });

    const anomalyCount = await step.run('anomalies', async () => {
      const findings = await runAnomalySweep(organizationId);
      return writeFindings(organizationId, findings);
    });

    logger.info({ organizationId, dupCount, integrityCount, anomalyCount }, 'audit-sweep: complete');
    return { organizationId, dupCount, integrityCount, anomalyCount };
  },
);
