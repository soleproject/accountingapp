import 'server-only';
import { and, eq, gte, lte, lt, asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  transactions,
  journalEntries,
  journalEntryLines,
  chartOfAccounts,
  reconciliationPeriods,
  reconciliationMatches,
} from '@/db/schema/schema';
import { round2 } from './dates';
import type { LedgerTxn } from './types';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Ledger transactions posted against a bank GL account within a month. */
export async function gatherLedgerTxns(
  organizationId: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<LedgerTxn[]> {
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      amount: transactions.amount,
      type: transactions.type,
      importId: transactions.importId,
      reference: transactions.reference,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.accountId, accountId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        // Quarantined duplicates carry no GL impact and must not enter the
        // reconciliation pool (they'd show as spurious unmatched ledger items).
        sql`${transactions.dedupeState} <> 'duplicate'`,
      ),
    )
    .orderBy(asc(transactions.date));

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    description: r.description ?? '',
    // Canonical sign: deposit (money in) → +, withdrawal (money out) → -.
    signedAmount: round2((r.type === 'deposit' ? 1 : -1) * Math.abs(num(r.amount))),
    isManual: r.importId == null && !(r.reference ?? '').startsWith('plaid:'),
    reference: r.reference ?? null,
  }));
}

/**
 * Authoritative GL balance for a bank account as-of a date, from posted journal
 * entry lines (NOT a transactions sum — manual JEs may have no transactions row).
 * For a bank account (normalBalance='debit') balance = SUM(debit - credit).
 */
export async function ledgerBalanceAsOf(
  organizationId: string,
  accountId: string,
  asOfDate: string,
  normalBalance: string,
): Promise<number> {
  const [agg] = await db
    .select({
      net: sql<number>`coalesce(sum(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)::float8`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.organizationId, organizationId),
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntries.posted, true),
        lte(journalEntries.date, asOfDate),
      ),
    );
  const net = num(agg?.net); // debit - credit
  return round2(normalBalance === 'credit' ? -net : net);
}

function signedLedger(type: string | null, amount: number | null): number {
  return round2((type === 'deposit' ? 1 : -1) * Math.abs(amount ?? 0));
}

/**
 * Transaction ids on this account that have been "cleared" — i.e. matched to a
 * statement line in some reconciliation. Optionally exclude one period (the one
 * being recomputed, whose matches we're about to rewrite).
 */
export async function clearedTxnIds(
  organizationId: string,
  accountId: string,
  excludePeriodId?: string | null,
): Promise<Set<string>> {
  const rows = await db
    .select({ txnId: reconciliationMatches.transactionId, periodId: reconciliationMatches.reconciliationPeriodId })
    .from(reconciliationMatches)
    .innerJoin(reconciliationPeriods, eq(reconciliationPeriods.id, reconciliationMatches.reconciliationPeriodId))
    .where(and(eq(reconciliationPeriods.organizationId, organizationId), eq(reconciliationPeriods.accountId, accountId)));
  const s = new Set<string>();
  for (const r of rows) {
    if (excludePeriodId && r.periodId === excludePeriodId) continue;
    s.add(r.txnId);
  }
  return s;
}

/** Earliest reconciliation period start for an account (bounds carry-forward). */
export async function earliestPeriodStart(organizationId: string, accountId: string): Promise<string | null> {
  const [r] = await db
    .select({ start: sql<string | null>`min(${reconciliationPeriods.startDate})` })
    .from(reconciliationPeriods)
    .where(and(eq(reconciliationPeriods.organizationId, organizationId), eq(reconciliationPeriods.accountId, accountId)));
  return r?.start ?? null;
}

/**
 * Outstanding (uncleared) ledger transactions carried forward from earlier
 * periods: dated in [sinceDate, beforeDate) and not yet matched. `sinceDate`
 * (the account's first reconciliation) bounds this so we never treat the entire
 * pre-reconciliation history as "outstanding".
 */
export async function gatherCarriedForward(
  organizationId: string,
  accountId: string,
  sinceDate: string,
  beforeDate: string,
  cleared: Set<string>,
): Promise<LedgerTxn[]> {
  if (sinceDate >= beforeDate) return [];
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      amount: transactions.amount,
      type: transactions.type,
      importId: transactions.importId,
      reference: transactions.reference,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.accountId, accountId),
        gte(transactions.date, sinceDate),
        lt(transactions.date, beforeDate),
      ),
    )
    .orderBy(asc(transactions.date));
  return rows
    .filter((r) => !cleared.has(r.id))
    .map((r) => ({
      id: r.id,
      date: r.date,
      description: r.description ?? '',
      signedAmount: signedLedger(r.type, r.amount),
      isManual: r.importId == null && !(r.reference ?? '').startsWith('plaid:'),
      reference: r.reference ?? null,
    }));
}

/** normalBalance for a single account (for the balance math). */
export async function getAccountNormalBalance(accountId: string): Promise<{ name: string; normalBalance: string } | null> {
  const [a] = await db
    .select({ name: chartOfAccounts.accountName, normalBalance: chartOfAccounts.normalBalance })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, accountId))
    .limit(1);
  return a ?? null;
}
