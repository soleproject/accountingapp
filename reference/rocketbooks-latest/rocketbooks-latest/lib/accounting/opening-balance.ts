import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, journalEntries, plaidAccounts, plaidRawTransactions } from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';

/**
 * Opening balances. A freshly linked/imported bank (or credit-card) account
 * starts at $0 in the ledger because the GL is built purely from posted journal
 * entries — there's no opening-balance JE. That's the "books are off until you
 * manually fix the starting balance" complaint, and it makes every
 * reconciliation show a false difference.
 *
 * setAccountOpeningBalance posts a one-time opening-balance JE
 * (Debit the account / Credit Opening Balance Equity, or the reverse for a
 * credit-normal account) and records startingBalance/startingBalanceDate on the
 * account. It is idempotent and replaceable: re-running with the same amount+date
 * is a no-op; a changed amount reverses the prior opening JE and posts a new one.
 *
 * Source of the number: the statement's starting_balance (Veryfi) or Plaid's
 * current balance minus the synced transactions — see the callers.
 */

// Drizzle's tx callback param has no clean exported type — infer it.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const OPENING_BALANCE_SOURCE = 'opening_balance';

/** Find the org's Opening Balance Equity account, creating it if missing. */
async function ensureOpeningBalanceEquity(orgId: string, exec: Tx): Promise<string> {
  const [existing] = await exec
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.detailType, 'opening_balance_equity')))
    .limit(1);
  if (existing) return existing.id;

  // Rare fallback — the standard CoA taxonomy seeds this. Pick the next free
  // equity-range account number.
  const rows = await exec
    .select({ accountNumber: chartOfAccounts.accountNumber })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const used = new Set(rows.map((r) => r.accountNumber));
  let accountNumber = '3000';
  for (let n = 3000; n < 9999; n++) {
    if (!used.has(String(n))) {
      accountNumber = String(n);
      break;
    }
  }

  const id = randomUUID();
  await exec.insert(chartOfAccounts).values({
    id,
    organizationId: orgId,
    accountNumber,
    accountName: 'Opening Balance Equity',
    gaapType: 'equity',
    accountType: 'equity',
    detailType: 'opening_balance_equity',
    normalBalance: 'credit',
    isActive: true,
    systemGenerated: true,
    passedNameContactCheck: true,
  });
  return id;
}

export interface SetOpeningBalanceInput {
  organizationId: string;
  /** The bank / credit-card chart-of-accounts row to set the opening balance on. */
  accountId: string;
  /** Opening balance in the account's NATURAL sign (positive = its normal side:
   *  cash on hand for a bank asset, amount owed for a credit card). */
  amount: number;
  /** YYYY-MM-DD the balance was true (statement period start / day before first txn). */
  asOfDate: string;
  /** Where the number came from — for the JE memo + audit. */
  source?: 'statement' | 'plaid' | 'manual';
}

export interface SetOpeningBalanceResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  journalEntryId?: string;
}

/**
 * Set (or replace) an account's opening balance. Idempotent on (amount, date).
 */
export async function setAccountOpeningBalance(input: SetOpeningBalanceInput): Promise<SetOpeningBalanceResult> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount)) return { ok: false, reason: 'invalid_amount' };
  const asOfDate = String(input.asOfDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return { ok: false, reason: 'invalid_date' };

  const [acct] = await db
    .select({
      id: chartOfAccounts.id,
      normalBalance: chartOfAccounts.normalBalance,
      startingBalance: chartOfAccounts.startingBalance,
      startingBalanceDate: chartOfAccounts.startingBalanceDate,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, input.accountId), eq(chartOfAccounts.organizationId, input.organizationId)))
    .limit(1);
  if (!acct) return { ok: false, reason: 'account_not_found' };

  // Idempotent: same amount + date → nothing to do.
  const priorAmount = acct.startingBalance != null ? Number(acct.startingBalance) : null;
  if (priorAmount != null && priorAmount === amount && acct.startingBalanceDate === asOfDate) {
    return { ok: true, skipped: true, reason: 'unchanged' };
  }

  const memo = `Opening balance${input.source ? ` (${input.source})` : ''}`;

  return db.transaction(async (tx) => {
    // Reverse any prior opening-balance JE for this account (replace semantics).
    const priorJes = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.organizationId, input.organizationId),
          eq(journalEntries.sourceType, OPENING_BALANCE_SOURCE),
          eq(journalEntries.sourceId, input.accountId),
          isNull(journalEntries.reversalOfId),
        ),
      );
    for (const je of priorJes) {
      await reverseJournalEntry(
        { organizationId: input.organizationId, journalEntryId: je.id, reversalMemo: 'Opening balance superseded' },
        tx,
      );
    }

    let journalEntryId: string | undefined;
    if (amount !== 0) {
      const obeId = await ensureOpeningBalanceEquity(input.organizationId, tx);
      // Express the account's target balance as a signed debit (positive = net
      // debit to the account). OBE takes the mirror so the entry balances.
      const debitSigned = acct.normalBalance === 'debit' ? amount : -amount;
      const accountDebit = debitSigned > 0 ? debitSigned : 0;
      const accountCredit = debitSigned < 0 ? -debitSigned : 0;
      const je = await createJournalEntry(
        {
          organizationId: input.organizationId,
          date: asOfDate,
          memo,
          posted: true,
          sourceType: OPENING_BALANCE_SOURCE,
          sourceId: input.accountId,
          isAdjusting: true,
          lines: [
            { accountId: input.accountId, debit: accountDebit, credit: accountCredit, memo },
            { accountId: obeId, debit: accountCredit, credit: accountDebit, memo },
          ],
        },
        tx,
      );
      journalEntryId = je.id;
    }

    await tx
      .update(chartOfAccounts)
      .set({ startingBalance: String(amount), startingBalanceDate: asOfDate })
      .where(and(eq(chartOfAccounts.id, input.accountId), eq(chartOfAccounts.organizationId, input.organizationId)));

    return { ok: true, journalEntryId };
  });
}

/**
 * Derive a bank account's opening balance from its live current balance + the
 * BANK FEED (Plaid), and post it. The opening is the bank's balance before its
 * first synced transaction:
 *   opening = currentBalance − (net bank movement)
 *           = currentBalance + sign · Σ(raw Plaid amounts)
 * Plaid: +amount = money OUT; sign = +1 for debit-normal (bank), −1 for
 * credit-normal (card). Mirrors the reconciliation source's reconstruction.
 *
 * IMPORTANT: it derives from the bank feed ONLY — NOT from `current − all
 * ledger transactions`. Using the full ledger back-solves the opening to force
 * the current month to tie out, which (a) produces nonsense openings when the
 * account carries non-feed postings (manual/QBO entries) and (b) hides a real
 * books-vs-bank gap. Feed-based opening keeps the opening a real number and lets
 * genuine discrepancies surface in reconciliation for review.
 *
 * `currentBalance` is in the account's NATURAL sign (cash for a bank, owed for a
 * card) — exactly what Plaid's balances.current returns.
 */
export async function setOpeningBalanceFromCurrent(input: {
  organizationId: string;
  accountId: string;
  currentBalance: number;
  asOfDate: string;
}): Promise<SetOpeningBalanceResult> {
  const [acct] = await db
    .select({ normalBalance: chartOfAccounts.normalBalance })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, input.accountId), eq(chartOfAccounts.organizationId, input.organizationId)))
    .limit(1);
  if (!acct) return { ok: false, reason: 'account_not_found' };

  // Sum the raw Plaid amounts for the in-scope Plaid account(s) mapped here.
  const plaids = await db
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.linkedOrganizationId, input.organizationId),
        eq(plaidAccounts.chartOfAccountId, input.accountId),
        eq(plaidAccounts.inScope, true),
      ),
    );
  let plaidSum = 0;
  if (plaids.length > 0) {
    const [agg] = await db
      .select({ s: sql<number>`coalesce(sum(${plaidRawTransactions.amount}::numeric), 0)::float` })
      .from(plaidRawTransactions)
      .where(inArray(plaidRawTransactions.plaidAccountId, plaids.map((p) => p.id)));
    plaidSum = Number(agg?.s ?? 0);
  }

  const sign = acct.normalBalance === 'debit' ? 1 : -1;
  const opening = Math.round((Number(input.currentBalance) + sign * plaidSum) * 100) / 100;
  // Present credit (liability) openings owed-positive, matching the recon source.
  const amount = acct.normalBalance === 'credit' ? Math.abs(opening) : opening;

  return setAccountOpeningBalance({
    organizationId: input.organizationId,
    accountId: input.accountId,
    amount,
    asOfDate: input.asOfDate,
    source: 'plaid',
  });
}
