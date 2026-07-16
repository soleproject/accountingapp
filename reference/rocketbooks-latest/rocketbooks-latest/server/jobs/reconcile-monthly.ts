import 'server-only';
import { inngest } from '@/lib/inngest';
import { reconcilableAccounts, priorMonth } from '@/lib/reconciliation/backfill';
import { logger } from '@/lib/logger';

/**
 * Monthly auto-reconciliation. Fires at 06:00 UTC on the 2nd of every month
 * (a day after close so the prior month's statements/Plaid data have settled)
 * and dispatches a reconciliation run for the month that just ended, for every
 * reconcilable account (in-scope Plaid or with statement imports).
 *
 * Each run is handled by the `reconcile` function — idempotent period upsert,
 * auto-reconcile or create a task. triggeredBy='cron' so OPEN months DO create
 * a task (unlike historical backfill, which is silent).
 */
export const reconcileMonthly = inngest.createFunction(
  {
    id: 'reconcile-monthly',
    retries: 2,
    triggers: [{ cron: '0 6 2 * *' }],
  },
  async ({ step }) => {
    const { year, month } = priorMonth(new Date());

    const accounts = await step.run('load-reconcilable-accounts', () => reconcilableAccounts());
    if (accounts.length === 0) {
      logger.info({ year, month }, 'reconcile-monthly: no reconcilable accounts');
      return { dispatched: 0, year, month };
    }

    await step.sendEvent(
      'dispatch-monthly-recon',
      accounts.map((a) => ({
        name: 'reconciliation/run.requested',
        data: { organizationId: a.organizationId, accountId: a.accountId, year, month, triggeredBy: 'cron' as const },
      })),
    );

    logger.info({ dispatched: accounts.length, year, month }, 'reconcile-monthly dispatched');
    return { dispatched: accounts.length, year, month };
  },
);
