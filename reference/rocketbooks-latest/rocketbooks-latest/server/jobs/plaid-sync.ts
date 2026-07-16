import 'server-only';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import {
  plaidAccounts,
  plaidRawTransactions,
  plaidSyncBatches,
  plaidBalanceSnapshots,
  transactions,
  generalLedger,
  journalEntryLines,
  journalEntries,
  reconciliationMatches,
  statementLines,
  transactionSubstantiation,
  receiptMatchApplications,
  receiptMatchSuggestions,
  personalTransactions,
} from '@/db/schema/schema';
import { plaid } from '@/lib/plaid/client';
import { decryptToken } from '@/lib/plaid/encryption';
import { logger } from '@/lib/logger';

/**
 * Apply a Plaid removal: Plaid's /transactions/sync `removed` array is
 * authoritative — a transaction it lists no longer exists (most commonly a
 * PENDING copy that has now posted under a new id). Delete the raw row AND any
 * promoted transaction so it can't linger as a duplicate: for a business account,
 * hard-delete the transaction + its JE (GL → lines → JE, matching delete-import.ts)
 * + unwind its reconciliation/receipt/substantiation links; for personal, drop the
 * ledger row. Best-effort per id (a failure must not fail the whole sync).
 */
async function applyPlaidRemoval(
  account: { id: string; linkedOrganizationId: string | null; linkedPersonalId: string | null },
  plaidTxnId: string,
): Promise<void> {
  await db
    .delete(plaidRawTransactions)
    .where(and(eq(plaidRawTransactions.plaidAccountId, account.id), eq(plaidRawTransactions.plaidTransactionId, plaidTxnId)));

  if (account.linkedOrganizationId) {
    const ref = `plaid:${plaidTxnId}`;
    const [txn] = await db
      .select({ id: transactions.id, journalEntryId: transactions.journalEntryId })
      .from(transactions)
      .where(and(eq(transactions.organizationId, account.linkedOrganizationId), eq(transactions.reference, ref)))
      .limit(1);
    if (txn) {
      if (txn.journalEntryId) {
        await db.delete(generalLedger).where(eq(generalLedger.journalEntryId, txn.journalEntryId));
        await db.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, txn.journalEntryId));
        await db.delete(journalEntries).where(eq(journalEntries.id, txn.journalEntryId));
      }
      await db.delete(reconciliationMatches).where(eq(reconciliationMatches.transactionId, txn.id));
      await db.update(statementLines).set({ matchedTransactionId: null }).where(eq(statementLines.matchedTransactionId, txn.id));
      await db.delete(transactionSubstantiation).where(eq(transactionSubstantiation.transactionId, txn.id));
      await db.delete(receiptMatchApplications).where(eq(receiptMatchApplications.transactionId, txn.id));
      await db.delete(receiptMatchSuggestions).where(eq(receiptMatchSuggestions.transactionId, txn.id));
      await db.delete(transactions).where(eq(transactions.id, txn.id));
      logger.info({ orgId: account.linkedOrganizationId, ref }, 'plaid-sync: applied Plaid removal (deleted transaction + JE)');
    }
  }

  if (account.linkedPersonalId) {
    await db.delete(personalTransactions).where(eq(personalTransactions.plaidTransactionId, plaidTxnId));
  }
}

export const plaidSync = inngest.createFunction(
  {
    id: 'plaid-sync',
    concurrency: { limit: 1, key: 'event.data.accountId' },
    retries: 3,
    triggers: [{ event: 'plaid/sync.requested' }],
  },
  async ({ event, step }) => {
    const { accountId, trigger } = event.data as { accountId: string; trigger: string };
    logger.info({ accountId, trigger }, 'plaid sync starting');

    try {
      const account = await step.run('load-account', async () => {
        const [a] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, accountId)).limit(1);
        if (!a) throw new Error(`Plaid account ${accountId} not found`);
        return a;
      });

      const accessToken = decryptToken(account.plaidAccessToken);
      let cursor: string | null = account.plaidCursor ?? null;
      let hasMore = true;
      let pageNum = 0;
      let totalAdded = 0;
      let totalModified = 0;
      let totalRemoved = 0;
      let syncedBalance: string | null = null;

      while (hasMore) {
        pageNum++;
        const page = await step.run(`fetch-page-${pageNum}`, async () => {
          const res = await plaid.transactionsSync({
            access_token: accessToken,
            cursor: cursor ?? undefined,
            count: 500,
          });
          return res.data;
        });

        await step.run(`persist-page-${pageNum}`, async () => {
          const now = new Date().toISOString();
          // Plaid's /transactions/sync returns the entire item's transactions
          // (access_token is item-scoped). This function is invoked per-account
          // — skip transactions that belong to a sibling account or we'll
          // duplicate raw rows once per account in the item.
          for (const t of page.added) {
            if (t.account_id !== account.plaidAccountId) continue;
            await db
              .insert(plaidRawTransactions)
              .values({
                id: randomUUID(),
                plaidAccountId: account.id,
                plaidTransactionId: t.transaction_id,
                date: t.date,
                amount: String(t.amount),
                description: t.name ?? null,
                rawJson: t,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing();
          }
          await db.insert(plaidSyncBatches).values({
            id: randomUUID(),
            plaidAccountId: account.id,
            cursor: page.next_cursor ?? null,
            addedCount: page.added.length,
            modifiedCount: page.modified.length,
            removedCount: page.removed.length,
            rawJson: { has_more: page.has_more },
            createdAt: now,
          });
        });

        // Honor Plaid's removals — most often a PENDING copy that has now posted
        // under a new id (the pending→posted duplicate). Delete the raw row + any
        // promoted transaction so it can't linger.
        if (page.removed.length > 0) {
          await step.run(`apply-removals-${pageNum}`, async () => {
            for (const rem of page.removed) {
              const rid = typeof rem === 'string' ? rem : (rem as { transaction_id?: string }).transaction_id;
              if (!rid) continue;
              try {
                await applyPlaidRemoval(account, rid);
              } catch (err) {
                logger.warn(
                  { accountId: account.id, rid, err: err instanceof Error ? err.message : String(err) },
                  'plaid-sync: removal cleanup failed (non-fatal)',
                );
              }
            }
          });
        }

        // Capture the account balance straight off the sync response — no extra
        // metered /accounts/balance/get. /transactions/sync returns the item's
        // accounts[] with balances that are as fresh as the latest transaction
        // update, which is exactly what reconciliation needs (and keeps balance
        // + transactions a single consistent snapshot). Last page wins.
        const acctBal = page.accounts?.find((a) => a.account_id === account.plaidAccountId)?.balances;
        if (acctBal) syncedBalance = String(acctBal.current ?? acctBal.available ?? 0);

        totalAdded += page.added.length;
        totalModified += page.modified.length;
        totalRemoved += page.removed.length;
        cursor = page.next_cursor;
        hasMore = page.has_more;
      }

      await step.run('finalize', async () => {
        await db
          .update(plaidAccounts)
          .set({
            plaidCursor: cursor,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: 'idle',
            lastSyncError: null,
            lastSyncErrorAt: null,
            ...(syncedBalance != null ? { balance: syncedBalance } : {}),
          })
          .where(eq(plaidAccounts.id, accountId));

        // Snapshot the bank-reported balance (already free from the sync response),
        // one row per account per day, so reconciliation has an INDEPENDENT per-period
        // anchor instead of rolling the single live balance back through the feed.
        if (syncedBalance != null) {
          await db
            .insert(plaidBalanceSnapshots)
            .values({
              id: randomUUID(),
              plaidAccountId: account.id,
              organizationId: account.linkedOrganizationId ?? null,
              snapshotDate: new Date().toISOString().slice(0, 10),
              balance: syncedBalance,
            })
            .onConflictDoUpdate({
              target: [plaidBalanceSnapshots.plaidAccountId, plaidBalanceSnapshots.snapshotDate],
              set: { balance: syncedBalance },
            });
        }
      });

      await step.sendEvent('post-sync', {
        name: 'plaid/sync.completed',
        data: { accountId, added: totalAdded, modified: totalModified, removed: totalRemoved },
      });

      return { added: totalAdded, modified: totalModified, removed: totalRemoved };
    } catch (err) {
      // Persist the error so the integrations/plaid/[id] page's "Last sync
      // error" panel actually has data to display, then rethrow so Inngest
      // still retries per its policy.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ accountId, trigger, err: msg }, 'plaid sync failed');
      await db
        .update(plaidAccounts)
        .set({
          syncStatus: 'error',
          lastSyncError: msg.slice(0, 1000),
          lastSyncErrorAt: new Date().toISOString(),
        })
        .where(eq(plaidAccounts.id, accountId))
        .catch(() => {
          /* swallow secondary failure; original error wins */
        });
      throw err;
    }
  },
);
