import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts, plaidRawTransactions, personalAccounts, personalTransactions } from '@/db/schema/schema';
import { getPersonalRules, matchRule, ensureCategory } from '@/lib/personal/categories';
import { pfcToCategory } from '@/lib/personal/pfc';
import { scanAndStoreRecurring } from '@/lib/personal/recurring';
import { logger } from '@/lib/logger';

interface PlaidRawJson {
  name?: string;
  merchant_name?: string;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
  /** Plaid marks a charge `pending` before it posts; the posted copy carries the
   *  pending copy's id in `pending_transaction_id`. */
  pending?: boolean;
  pending_transaction_id?: string | null;
}

export interface PersonalPromoteResult {
  promoted: number;
  skipped: number;
  reason?: string;
}

/**
 * Mirror a personal Plaid account's raw transactions into personal_transactions.
 *
 * This is the personal-side counterpart to lib/accounting/plaid-promote.ts. It
 * is intentionally simple: personal transactions are a flat ledger for the
 * Monarch-style Personal product — no journal entries, no GL, no contact
 * resolution. Dedupe is by Plaid's transaction id (unique index on
 * personal_transactions.plaid_transaction_id).
 */
export async function promotePersonalPlaidAccount(args: {
  plaidAccountId: string;
}): Promise<PersonalPromoteResult> {
  const [account] = await db
    .select()
    .from(plaidAccounts)
    .where(eq(plaidAccounts.id, args.plaidAccountId))
    .limit(1);
  if (!account) return { promoted: 0, skipped: 0, reason: 'plaid account not found' };
  if (!account.linkedPersonalId) return { promoted: 0, skipped: 0, reason: 'not a personal account' };

  const [personal] = await db
    .select({ id: personalAccounts.id, userId: personalAccounts.userId })
    .from(personalAccounts)
    .where(eq(personalAccounts.id, account.linkedPersonalId))
    .limit(1);
  if (!personal) return { promoted: 0, skipped: 0, reason: 'linked personal account missing' };

  const raw = await db
    .select({
      plaidTransactionId: plaidRawTransactions.plaidTransactionId,
      date: plaidRawTransactions.date,
      amount: plaidRawTransactions.amount,
      description: plaidRawTransactions.description,
      rawJson: plaidRawTransactions.rawJson,
    })
    .from(plaidRawTransactions)
    .where(eq(plaidRawTransactions.plaidAccountId, account.id));

  if (raw.length === 0) return { promoted: 0, skipped: 0, reason: 'no raw transactions yet' };

  // Plaid pending→posted dedup (mirrors lib/accounting/plaid-promote.ts): the POSTED
  // copy references the pending copy's id in `pending_transaction_id`. Skip promoting
  // the pending copy, and when the posted lands adopt an already-promoted pending in
  // place — no journal entries here, so it's just a row update.
  const supersededPendingIds = new Set<string>();
  for (const r of raw) {
    const j = (r.rawJson ?? {}) as PlaidRawJson;
    if (j.pending === false && j.pending_transaction_id) supersededPendingIds.add(j.pending_transaction_id);
  }

  // Load the user's auto-categorization rules once; applied per transaction
  // ahead of Plaid's PFC fallback so a merchant rule wins over the bank's guess.
  const rules = await getPersonalRules(personal.userId);
  // PFC-derived categories we encounter, so we can ensure each exists in the
  // registry after the batch (one upsert per distinct category, not per txn).
  const ensureSet = new Map<string, string>();

  let promoted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const r of raw) {
    const meta = (r.rawJson ?? {}) as PlaidRawJson;
    const isPending = meta.pending === true;
    const pendingTxnId = meta.pending_transaction_id ?? null;
    // Skip a pending copy that a posted row in this batch supersedes.
    if (isPending && supersededPendingIds.has(r.plaidTransactionId)) {
      skipped++;
      continue;
    }
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) {
      skipped++;
      continue;
    }
    const merchant = meta.merchant_name ?? null;
    const description = meta.name ?? r.description ?? null;
    const ruleCat = matchRule(rules, { merchant, description });
    let category: string;
    if (ruleCat) {
      category = ruleCat;
    } else {
      const c = pfcToCategory(meta.personal_finance_category);
      category = c.name;
      ensureSet.set(c.name, c.group);
    }
    // Posted supersedes an already-promoted pending twin → adopt it in place (new
    // Plaid id + fuller description + posted date/amount) instead of a duplicate.
    if (!isPending && pendingTxnId) {
      const [twin] = await db
        .select({ id: personalTransactions.id })
        .from(personalTransactions)
        .where(eq(personalTransactions.plaidTransactionId, pendingTxnId))
        .limit(1);
      if (twin) {
        await db
          .update(personalTransactions)
          .set({
            plaidTransactionId: r.plaidTransactionId,
            date: r.date,
            amount: String(amount),
            category,
            description,
            merchant,
            updatedAt: now,
          })
          .where(eq(personalTransactions.id, twin.id));
        continue;
      }
    }

    const inserted = await db
      .insert(personalTransactions)
      .values({
        id: randomUUID(),
        userId: personal.userId,
        accountId: personal.id,
        date: r.date,
        // Personal ledger keeps Plaid's sign convention: positive = money out
        // (spending), negative = money in (income/credit).
        amount: String(amount),
        category,
        description,
        merchant,
        plaidTransactionId: r.plaidTransactionId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: personalTransactions.plaidTransactionId })
      .returning({ id: personalTransactions.id });

    if (inserted.length > 0) promoted++;
    else skipped++;
  }

  // Make sure every PFC-derived category exists in the registry so it shows up
  // in the picker, budgets, and reports.
  for (const [name, group] of ensureSet) {
    await ensureCategory(personal.userId, name, group);
  }

  // Keep the personal account balance in step with the latest Plaid balance
  // snapshot captured at link/sync time.
  if (account.balance != null) {
    await db
      .update(personalAccounts)
      .set({ balance: String(account.balance), updatedAt: now })
      .where(eq(personalAccounts.id, personal.id));
  }

  // Refresh detected recurring charges from the updated transaction history.
  // Best-effort — a detection failure must not fail the promote.
  if (promoted > 0) {
    try {
      await scanAndStoreRecurring(personal.userId, new Date());
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'personal recurring scan failed (non-fatal)');
    }
  }

  logger.info({ plaidAccountId: account.id, personalAccountId: personal.id, promoted, skipped }, 'personal plaid promote done');
  return { promoted, skipped };
}
