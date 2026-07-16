import 'server-only';
import { and, eq, gte, lte, asc, desc, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, importedTransactions, plaidAccounts, plaidRawTransactions, plaidBalanceSnapshots } from '@/db/schema/schema';
import { round2 } from './dates';
import type { SourceData, SourceLine } from './types';

/**
 * Pick the source of truth for (account, month): the uploaded bank statement is
 * authoritative; Plaid is the fallback when no statement covers the month.
 * Returns null when neither source exists (engine then SKIPs — no period).
 */
export async function gatherSource(
  organizationId: string,
  accountId: string,
  startDate: string,
  endDate: string,
  normalBalance: string,
): Promise<SourceData | null> {
  const stmt = await gatherStatementSource(organizationId, accountId, startDate, endDate, normalBalance);
  if (stmt) return stmt;
  return gatherPlaidSource(organizationId, accountId, startDate, endDate, normalBalance);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Credit-card (liability, normalBalance='credit') statements/feeds report a
 * balance OWED. ledgerBalanceAsOf returns the liability balance as a positive
 * "owed" figure, so normalize the source's closing/opening to owed-positive
 * regardless of how the OCR/Plaid signs it. (A genuine credit/overpayment
 * balance is a rare edge case that surfaces as an OPEN period for review.)
 */
function normalizeOwed(balance: number | null, normalBalance: string): number | null {
  if (balance == null) return null;
  return normalBalance === 'credit' ? Math.abs(balance) : balance;
}

/** A bank statement import whose period closes within the target month. */
async function gatherStatementSource(
  organizationId: string,
  accountId: string,
  startDate: string,
  endDate: string,
  normalBalance: string,
): Promise<SourceData | null> {
  // Latest statement whose endDate lands in the month wins (handles re-uploads).
  const [imp] = await db
    .select({
      id: imports.id,
      startDate: imports.startDate,
      endDate: imports.endDate,
      veryfiRawJson: imports.veryfiRawJson,
    })
    .from(imports)
    .where(
      and(
        eq(imports.organizationId, organizationId),
        eq(imports.accountId, accountId),
        eq(imports.importMethod, 'bank_statement'),
        gte(imports.endDate, startDate),
        lte(imports.endDate, endDate),
      ),
    )
    .orderBy(desc(imports.endDate))
    .limit(1);
  if (!imp) return null;

  const rows = await db
    .select({
      id: importedTransactions.id,
      date: importedTransactions.date,
      description: importedTransactions.description,
      amount: importedTransactions.amount,
      type: importedTransactions.type,
      credit: importedTransactions.credit,
      debit: importedTransactions.debit,
      balance: importedTransactions.balance,
      referenceNumber: importedTransactions.referenceNumber,
      promotedTransactionId: importedTransactions.promotedTransactionId,
    })
    .from(importedTransactions)
    .where(eq(importedTransactions.importId, imp.id))
    .orderBy(asc(importedTransactions.date));

  const lines: SourceLine[] = rows.map((r) => {
    // Canonical sign: credit (money in) → +, debit (money out) → -. Prefer the
    // explicit type+amount; fall back to the separate debit/credit columns.
    let signed: number;
    if (r.type === 'credit' || r.type === 'debit') {
      signed = (r.type === 'credit' ? 1 : -1) * Math.abs(num(r.amount));
    } else {
      signed = num(r.credit) - num(r.debit);
    }
    return {
      externalId: r.referenceNumber ?? r.id,
      date: r.date ?? startDate,
      description: r.description ?? '',
      signedAmount: round2(signed),
      runningBalance: r.balance == null ? null : round2(num(r.balance)),
      matchHintTxnId: r.promotedTransactionId ?? null,
      matchHintRef: null,
    };
  });

  // Closing/opening from the Veryfi doc; fall back to the last/first line balance.
  let closing: number | null = null;
  let opening: number | null = null;
  try {
    const doc = imp.veryfiRawJson ? (JSON.parse(imp.veryfiRawJson) as Record<string, unknown>) : {};
    const end = doc.ending_balance ?? doc.closing_balance;
    const start = doc.starting_balance ?? doc.opening_balance;
    if (end != null && Number.isFinite(Number(end))) closing = round2(Number(end));
    if (start != null && Number.isFinite(Number(start))) opening = round2(Number(start));
  } catch {
    // malformed JSON — fall back to line balances below
  }
  if (closing == null && rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.balance != null) closing = round2(num(last.balance));
  }

  return {
    kind: 'statement',
    importId: imp.id,
    // Reconcile over the statement's printed period (billing cycle), not the
    // calendar month it happened to close in.
    periodStart: imp.startDate ?? startDate,
    periodEnd: imp.endDate ?? endDate,
    lines,
    openingBalance: normalizeOwed(opening, normalBalance),
    closingBalance: normalizeOwed(closing, normalBalance),
  };
}

/** In-scope Plaid account(s) mapped to this GL account, with raw txns in month. */
async function gatherPlaidSource(
  organizationId: string,
  accountId: string,
  startDate: string,
  endDate: string,
  normalBalance: string,
): Promise<SourceData | null> {
  const accts = await db
    .select({ id: plaidAccounts.id, balance: plaidAccounts.balance })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.linkedOrganizationId, organizationId),
        eq(plaidAccounts.chartOfAccountId, accountId),
        eq(plaidAccounts.inScope, true),
      ),
    );
  if (accts.length === 0) return null;

  // Live current balance (summed if multiple Plaid accounts map to one GL
  // account). Drives the reconstructed opening/closing below.
  let currentBalance: number | null = null;
  for (const a of accts) {
    if (a.balance != null) currentBalance = (currentBalance ?? 0) + Number(a.balance);
  }

  const lines: SourceLine[] = [];
  let closing: number | null = null;
  let closingDate = '';
  for (const a of accts) {
    const rows = await db
      .select({
        plaidTransactionId: plaidRawTransactions.plaidTransactionId,
        date: plaidRawTransactions.date,
        description: plaidRawTransactions.description,
        amount: plaidRawTransactions.amount,
        rawJson: plaidRawTransactions.rawJson,
      })
      .from(plaidRawTransactions)
      .where(
        and(
          eq(plaidRawTransactions.plaidAccountId, a.id),
          gte(plaidRawTransactions.date, startDate),
          lte(plaidRawTransactions.date, endDate),
        ),
      )
      .orderBy(asc(plaidRawTransactions.date));

    for (const r of rows) {
      const raw = (r.rawJson ?? {}) as Record<string, unknown>;
      // Plaid: positive = money OUT. Canonical (+ in) = negate.
      const signed = round2(-num(r.amount));
      const runningBalance = raw.balance != null && Number.isFinite(Number(raw.balance)) ? round2(Number(raw.balance)) : null;
      lines.push({
        externalId: r.plaidTransactionId,
        date: r.date ?? startDate,
        description: r.description ?? (raw.merchant_name as string) ?? (raw.name as string) ?? '',
        signedAmount: signed,
        runningBalance,
        matchHintTxnId: null,
        matchHintRef: `plaid:${r.plaidTransactionId}`,
      });
      // Closing balance = running balance of the latest dated txn in the month.
      if (runningBalance != null && (r.date ?? '') >= closingDate) {
        closing = runningBalance;
        closingDate = r.date ?? '';
      }
    }
  }
  if (lines.length === 0) return null;

  lines.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  // Plaid has no statement period → reconcile the calendar month. We reconstruct
  // a real closing/opening from the LIVE current balance. Plaid: +amount = money
  // OUT. A depository account's balance is cash; a credit card's reported balance
  // is OWED (a liability) — the inverse direction — so a single `sign` factor
  // keyed off normalBalance covers both:
  //   closing(periodEnd) = currentBalance + sign · Σ(raw Plaid amounts after periodEnd)
  //   opening(periodStart) = closing − sign · Σ(in-period canonical signed amounts)
  //   sign = +1 for debit-normal (bank), −1 for credit-normal (credit card)
  // normalizeOwed then presents credit balances as owed-positive.
  const sign = normalBalance === 'debit' ? 1 : -1;
  const acctIds = accts.map((a) => a.id);
  const sumLineSigned = round2(lines.reduce((s, l) => s + l.signedAmount, 0));

  let openingBalance: number | null = null;
  let closingBalance = normalizeOwed(closing, normalBalance);

  // Prefer an INDEPENDENT balance snapshot captured on/after the period end (the
  // bank's actual reported balance entering the next period ≈ this period's close)
  // over rolling the single live balance back through the same feed. Only used when
  // EVERY in-scope account has one, so a partial history can't skew the sum.
  const snaps = await db
    .select({ acct: plaidBalanceSnapshots.plaidAccountId, balance: plaidBalanceSnapshots.balance })
    .from(plaidBalanceSnapshots)
    .where(and(inArray(plaidBalanceSnapshots.plaidAccountId, acctIds), gte(plaidBalanceSnapshots.snapshotDate, endDate)))
    .orderBy(asc(plaidBalanceSnapshots.snapshotDate));
  const snapByAcct = new Map<string, number>();
  for (const s of snaps) if (!snapByAcct.has(s.acct)) snapByAcct.set(s.acct, Number(s.balance));

  if (acctIds.length > 0 && acctIds.every((id) => snapByAcct.has(id))) {
    const snapClosing = round2(acctIds.reduce((sum, id) => sum + (snapByAcct.get(id) ?? 0), 0));
    closingBalance = normalizeOwed(snapClosing, normalBalance);
    openingBalance = normalizeOwed(round2(snapClosing - sign * sumLineSigned), normalBalance);
  } else if (currentBalance != null) {
    // Fallback (periods before snapshots existed): reconstruct from the live balance.
    const [after] = await db
      .select({ s: sql<number>`coalesce(sum(${plaidRawTransactions.amount}::numeric), 0)::float` })
      .from(plaidRawTransactions)
      .where(and(inArray(plaidRawTransactions.plaidAccountId, acctIds), sql`${plaidRawTransactions.date} > ${endDate}`));
    const reClosing = round2(currentBalance + sign * Number(after?.s ?? 0));
    closingBalance = normalizeOwed(reClosing, normalBalance);
    openingBalance = normalizeOwed(round2(reClosing - sign * sumLineSigned), normalBalance);
  }

  return {
    kind: 'plaid',
    importId: null,
    periodStart: startDate,
    periodEnd: endDate,
    lines,
    openingBalance,
    closingBalance,
  };
}
