import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { plaidAccounts, plaidRawTransactions } from '@/db/schema/schema';
import { promotePlaidAccount } from '@/lib/accounting/plaid-promote';
import { setOpeningBalanceFromCurrent } from '@/lib/accounting/opening-balance';
import { enumerateAccountMonths, accountHasReconciliationPeriods } from '@/lib/reconciliation/backfill';
import { logger } from '@/lib/logger';

export const plaidPromoteOnSync = inngest.createFunction(
  {
    id: 'plaid-promote-on-sync',
    concurrency: { limit: 1, key: 'event.data.accountId' },
    retries: 2,
    triggers: [{ event: 'plaid/sync.completed' }],
  },
  async ({ event, step }) => {
    const { accountId } = event.data as { accountId: string };

    const account = await step.run('load-account', async () => {
      const [a] = await db
        .select({
          id: plaidAccounts.id,
          orgId: plaidAccounts.linkedOrganizationId,
          chartOfAccountId: plaidAccounts.chartOfAccountId,
          inScope: plaidAccounts.inScope,
          balance: plaidAccounts.balance,
        })
        .from(plaidAccounts)
        .where(eq(plaidAccounts.id, accountId))
        .limit(1);
      return a ?? null;
    });

    if (!account) {
      logger.warn({ accountId }, 'auto-promote: plaid account not found');
      return { skipped: true, reason: 'account_not_found' };
    }
    if (!account.orgId) {
      logger.warn({ accountId }, 'auto-promote: plaid account has no linked org');
      return { skipped: true, reason: 'no_org' };
    }
    if (!account.chartOfAccountId) {
      logger.info({ accountId }, 'auto-promote: skipping (no COA mapping)');
      return { skipped: true, reason: 'unmapped' };
    }
    if (!account.inScope) {
      // M22 used to auto-promote everything. With the in-scope flag restored,
      // accounts must be affirmatively marked as belonging to this business
      // before transactions enter the books. Personal accounts at the same
      // institution stay out of the books even though sync still pulls
      // their raw data (audit trail).
      logger.info({ accountId }, 'auto-promote: skipping (account not in scope)');
      return { skipped: true, reason: 'not_in_scope' };
    }

    const result = await step.run('promote', () =>
      promotePlaidAccount({ organizationId: account.orgId!, plaidAccountId: account.id }),
    );

    if (result.newTransactionIds.length > 0) {
      await step.sendEvent('emit-promote-completed', {
        name: 'plaid/promote.completed',
        data: {
          organizationId: account.orgId,
          plaidAccountId: account.id,
          transactionIds: result.newTransactionIds,
        },
      });
    }

    // Opening balance: now that the transactions are in the ledger and the
    // account's current balance is fresh, derive the opening balance
    // (current − ledger-from-transactions) and post it. Idempotent — a no-op
    // once set and unchanged. Dated the day before the earliest synced txn.
    await step.run('set-opening-balance', async () => {
      if (account.balance == null) return { skipped: 'no_balance' };
      const [first] = await db
        .select({ d: sql<string | null>`min(${plaidRawTransactions.date})` })
        .from(plaidRawTransactions)
        .where(eq(plaidRawTransactions.plaidAccountId, account.id));
      if (!first?.d) return { skipped: 'no_txns' };
      const asOfDate = new Date(Date.parse(`${first.d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      try {
        return await setOpeningBalanceFromCurrent({
          organizationId: account.orgId!,
          accountId: account.chartOfAccountId!,
          currentBalance: Number(account.balance),
          asOfDate,
        });
      } catch (err) {
        logger.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, 'plaid opening-balance set failed (non-fatal)');
        return { skipped: 'error' };
      }
    });

    // Reconciliation coverage: on first promote (no periods yet) backfill a
    // reconciliation for every month from first activity → now; otherwise just
    // keep the current month fresh. The reconcile fn auto-reconciles or tasks.
    const coverage = await step.run('plan-recon-coverage', async () => {
      if (!account.chartOfAccountId) return [] as Array<{ year: number; month: number; triggeredBy: 'backfill' | 'cron' }>;
      const hasPeriods = await accountHasReconciliationPeriods(account.orgId!, account.chartOfAccountId);
      if (hasPeriods) {
        const now = new Date();
        return [{ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, triggeredBy: 'cron' as const }];
      }
      const months = await enumerateAccountMonths(account.orgId!, account.chartOfAccountId);
      return months.map((m) => ({ ...m, triggeredBy: 'backfill' as const }));
    });
    if (coverage.length > 0) {
      await step.sendEvent(
        'dispatch-recon-coverage',
        coverage.map((e) => ({
          name: 'reconciliation/run.requested',
          data: {
            organizationId: account.orgId!,
            accountId: account.chartOfAccountId!,
            year: e.year,
            month: e.month,
            triggeredBy: e.triggeredBy,
          },
        })),
      );
    }

    logger.info(
      { accountId, promoted: result.promoted, skipped: result.skipped, reason: result.reason },
      'auto-promote done',
    );
    return result;
  },
);
