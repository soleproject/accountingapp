import { inngest } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { reconcileAccountMonth } from '@/lib/reconciliation/engine';
import { getAccountNormalBalance } from '@/lib/reconciliation/ledger';
import {
  upsertReconciliationTask,
  resolveReconciliationTask,
  resolveOrgOwnerUserId,
} from '@/lib/reconciliation/tasks';

/**
 * Run AI reconciliation for one (account, month). Fired by the statement-upload
 * route and the monthly cron. Per-account concurrency so two triggers for the
 * same account serialize (and the period upsert stays consistent); retried.
 */
export const reconcile = inngest.createFunction(
  {
    id: 'reconcile',
    concurrency: { limit: 1, key: 'event.data.accountId' },
    retries: 2,
    triggers: [{ event: 'reconciliation/run.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId, accountId, year, month, triggeredBy, userId } = event.data as {
      organizationId: string;
      accountId: string;
      year: number;
      month: number;
      triggeredBy: 'cron' | 'statement-upload' | 'manual' | 'backfill';
      userId?: string;
    };
    if (!organizationId || !accountId || !year || !month) {
      return { skipped: true, reason: 'no_input' };
    }

    const result = await step.run('reconcile', () =>
      reconcileAccountMonth({ organizationId, accountId, year, month, triggeredBy, userId }),
    );

    if (result.status === 'SKIPPED' || !result.periodId) return result;

    await step.run('needs-attention', async () => {
      if (result.status === 'OPEN') {
        // Historical backfill can open many months at once — don't spam one task
        // per month. Those OPEN periods still surface via the "reconciliation
        // off" attention card; only live triggers (statement/manual/cron) create
        // a per-period task.
        if (triggeredBy === 'backfill') return;
        const owner = userId ?? (await resolveOrgOwnerUserId(organizationId));
        if (!owner) {
          logger.warn({ organizationId, accountId }, 'reconcile: no owner — skipping needs-attention task');
          return;
        }
        const acct = await getAccountNormalBalance(accountId);
        await upsertReconciliationTask({
          organizationId,
          userId: owner,
          periodId: result.periodId!,
          accountName: acct?.name ?? 'bank account',
          difference: result.difference ?? null,
          explanation: result.explanation ?? '',
        });
      } else {
        await resolveReconciliationTask(result.periodId!);
      }
    });

    return result;
  },
);
