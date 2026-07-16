import 'server-only';
import { eq, and, isNull, lt, sql } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { transactions, chartOfAccounts } from '@/db/schema/schema';
import { createJournalEntryFromTransaction } from '@/lib/accounting/auto-post';
import { JournalEntryError } from '@/lib/accounting/posting';
import { logger } from '@/lib/logger';

const STALE_AFTER_MINUTES = 15;
const BATCH_LIMIT = 200;

/**
 * Safety net for transactions that never got a JE.
 *
 * Plaid promote stages PFC-fallback / unmapped txns with categoryAccountId
 * NULL and waits for auto-categorize to pick a real account before posting.
 * If auto-cat fails (OpenAI outage, low confidence, the txn was an
 * unrecognizable merchant), the txn would otherwise sit JE-less forever and
 * never appear on the GL. This job periodically grabs any txn older than 15
 * minutes that still has no JE, assigns the org's Uncategorized
 * Expense/Income account based on its type, and posts a JE so the books are
 * complete. The user resolves these via the normal review queue.
 *
 * Idempotency: we re-check `journalEntryId IS NULL` per row before posting
 * so concurrent auto-cat runs that finish between the SELECT and the post
 * don't create a duplicate JE.
 */
export const stuckPendingFallback = inngest.createFunction(
  {
    id: 'stuck-pending-fallback',
    retries: 2,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000).toISOString();

    const stuck = await step.run('load-stuck-txns', async () =>
      db
        .select({
          id: transactions.id,
          organizationId: transactions.organizationId,
          date: transactions.date,
          type: transactions.type,
          amount: transactions.amount,
          accountId: transactions.accountId,
          contactId: transactions.contactId,
          bankDescription: transactions.bankDescription,
          userDescription: transactions.userDescription,
        })
        .from(transactions)
        .where(
          and(
            isNull(transactions.journalEntryId),
            lt(sql`${transactions.createdAt}`, cutoff),
          ),
        )
        .limit(BATCH_LIMIT),
    );

    if (stuck.length === 0) {
      return { posted: 0, scanned: 0 };
    }

    // Pre-resolve each org's Uncategorized Expense + Income accounts in one
    // round-trip. Account names are seeded by default-coa-data.ts.
    const orgIds = Array.from(
      new Set(stuck.map((t: { organizationId: string | null }) => t.organizationId).filter((x: string | null): x is string => !!x)),
    );
    const orgAccounts = await step.run('load-uncategorized-accounts', async () =>
      db
        .select({
          id: chartOfAccounts.id,
          organizationId: chartOfAccounts.organizationId,
          accountName: chartOfAccounts.accountName,
        })
        .from(chartOfAccounts)
        .where(
          and(
            sql`${chartOfAccounts.organizationId} = ANY(${orgIds})`,
            sql`${chartOfAccounts.accountName} IN ('Uncategorized Expense', 'Uncategorized Income')`,
          ),
        ),
    );
    const accountByOrg = new Map<string, { expense?: string; income?: string }>();
    for (const a of orgAccounts) {
      const slot = accountByOrg.get(a.organizationId) ?? {};
      if (a.accountName === 'Uncategorized Expense') slot.expense = a.id;
      if (a.accountName === 'Uncategorized Income') slot.income = a.id;
      accountByOrg.set(a.organizationId, slot);
    }

    let posted = 0;
    let skipped = 0;
    for (const t of stuck) {
      if (!t.organizationId || !t.accountId || !t.type || t.amount == null || t.amount <= 0) {
        skipped++;
        continue;
      }
      const slots = accountByOrg.get(t.organizationId);
      if (!slots) {
        skipped++;
        continue;
      }
      const fallbackAccountId =
        t.type === 'deposit' ? slots.income : slots.expense;
      if (!fallbackAccountId) {
        skipped++;
        continue;
      }

      try {
        await db.transaction(async (tx) => {
          // Re-check inside the transaction in case auto-categorize finished
          // between our SELECT and now.
          const [latest] = await tx
            .select({ journalEntryId: transactions.journalEntryId })
            .from(transactions)
            .where(eq(transactions.id, t.id))
            .limit(1);
          if (!latest || latest.journalEntryId) return;

          const jeId = await createJournalEntryFromTransaction(
            {
              id: t.id,
              organizationId: t.organizationId!,
              date: t.date,
              type: t.type!,
              amount: t.amount!,
              accountId: t.accountId!,
              categoryAccountId: fallbackAccountId,
              contactId: t.contactId,
              bankDescription: t.bankDescription,
              userDescription: t.userDescription,
            },
            tx,
          );
          await tx
            .update(transactions)
            .set({ categoryAccountId: fallbackAccountId, journalEntryId: jeId, reviewed: false })
            .where(eq(transactions.id, t.id));
          posted++;
        });
      } catch (err) {
        skipped++;
        if (err instanceof JournalEntryError) {
          logger.warn(
            { txnId: t.id, orgId: t.organizationId, err: err.message },
            'stuck-pending-fallback: validation failure',
          );
        } else {
          logger.error(
            { txnId: t.id, orgId: t.organizationId, err: err instanceof Error ? err.message : String(err) },
            'stuck-pending-fallback: post failed',
          );
        }
      }
    }

    logger.info({ posted, skipped, scanned: stuck.length, cutoff }, 'stuck-pending-fallback done');
    return { posted, skipped, scanned: stuck.length };
  },
);
