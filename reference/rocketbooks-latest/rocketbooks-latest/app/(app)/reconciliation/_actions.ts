'use server';

import { randomUUID } from 'crypto';
import { and, eq, desc, lte } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import {
  reconciliationPeriods,
  statementLines,
  reconciliationMatches,
  transactions,
  chartOfAccounts,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { resolveReconciliationTask } from '@/lib/reconciliation/tasks';
import { gatherLedgerTxns, gatherCarriedForward, clearedTxnIds, earliestPeriodStart, ledgerBalanceAsOf } from '@/lib/reconciliation/ledger';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Load a period and verify it belongs to the caller's org. */
async function loadPeriod(periodId: string) {
  const orgId = await getCurrentOrgId();
  const [p] = await db
    .select({
      id: reconciliationPeriods.id,
      organizationId: reconciliationPeriods.organizationId,
      accountId: reconciliationPeriods.accountId,
      isManual: reconciliationPeriods.isManual,
    })
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);
  if (!p || p.organizationId !== orgId) return null;
  return p;
}

/**
 * Recompute a period's status after a line change.
 * - Manual (clear-the-transactions) periods reconcile when the cleared balance
 *   ties to the entered ending balance: ledger = beginning ± cleared (± per the
 *   account's normal balance), difference = ending − ledger, RECONCILED at zero.
 * - Statement periods: balanced AND every line accounted for.
 */
async function recompute(periodId: string): Promise<void> {
  const [p] = await db
    .select({
      difference: reconciliationPeriods.difference,
      isManual: reconciliationPeriods.isManual,
      accountId: reconciliationPeriods.accountId,
      statementOpening: reconciliationPeriods.statementOpeningBalance,
      statementClosing: reconciliationPeriods.statementClosingBalance,
    })
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);
  if (!p) return;

  const now = new Date().toISOString();

  if (p.isManual) {
    const [acct] = await db.select({ normalBalance: chartOfAccounts.normalBalance }).from(chartOfAccounts).where(eq(chartOfAccounts.id, p.accountId)).limit(1);
    const normalSign = acct?.normalBalance === 'credit' ? -1 : 1;
    const cleared = await db
      .select({ amount: statementLines.amount })
      .from(statementLines)
      .where(and(eq(statementLines.reconciliationPeriodId, periodId), eq(statementLines.status, 'MATCHED')));
    const clearedSum = r2(cleared.reduce((s, l) => s + Number(l.amount), 0));
    const beginning = p.statementOpening == null ? 0 : Number(p.statementOpening);
    const ending = p.statementClosing == null ? 0 : Number(p.statementClosing);
    const ledgerClosing = r2(beginning + normalSign * clearedSum);
    const difference = r2(ending - ledgerClosing);
    const status = Math.abs(difference) < 0.01 ? 'RECONCILED' : 'OPEN';
    await db
      .update(reconciliationPeriods)
      .set({ ledgerClosingBalance: ledgerClosing.toFixed(2), difference: difference.toFixed(2), status, updatedAt: now })
      .where(eq(reconciliationPeriods.id, periodId));
    if (status === 'RECONCILED') await resolveReconciliationTask(periodId);
    return;
  }

  // Statement mode.
  const lines = await db.select({ status: statementLines.status }).from(statementLines).where(eq(statementLines.reconciliationPeriodId, periodId));
  const diff = p.difference == null ? null : Number(p.difference);
  const balanced = diff != null && Math.abs(diff) < 0.01;
  const allAccounted = !lines.some((l) => l.status === 'UNMATCHED');
  const status = balanced && allAccounted ? 'RECONCILED' : 'OPEN';
  await db.update(reconciliationPeriods).set({ status, updatedAt: now }).where(eq(reconciliationPeriods.id, periodId));
  if (status === 'RECONCILED') await resolveReconciliationTask(periodId);
}

// ── Statement-mode line controls ──────────────────────────────────────────

export async function manualMatchAction(formData: FormData): Promise<void> {
  const user = await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  const txnId = String(formData.get('transactionId') ?? '');
  if (!periodId || !lineId || !txnId) return;
  const p = await loadPeriod(periodId);
  if (!p) return;

  const [line] = await db.select({ id: statementLines.id }).from(statementLines).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId))).limit(1);
  if (!line) return;
  const [txn] = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.id, txnId), eq(transactions.accountId, p.accountId), eq(transactions.organizationId, p.organizationId))).limit(1);
  if (!txn) return;
  const [dupe] = await db.select({ id: reconciliationMatches.id }).from(reconciliationMatches).where(and(eq(reconciliationMatches.reconciliationPeriodId, periodId), eq(reconciliationMatches.transactionId, txnId))).limit(1);
  if (dupe) return;

  const now = new Date().toISOString();
  await db.delete(reconciliationMatches).where(eq(reconciliationMatches.statementLineId, lineId));
  await db.insert(reconciliationMatches).values({ id: randomUUID(), reconciliationPeriodId: periodId, statementLineId: lineId, transactionId: txnId, matchType: 'EXACT', score: 1, createdBy: user.id, createdAt: now });
  await db.update(statementLines).set({ status: 'MATCHED', matchedTransactionId: txnId, updatedAt: now }).where(eq(statementLines.id, lineId));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

export async function unmatchLineAction(formData: FormData): Promise<void> {
  await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  if (!(await loadPeriod(periodId))) return;
  const now = new Date().toISOString();
  await db.delete(reconciliationMatches).where(eq(reconciliationMatches.statementLineId, lineId));
  await db.update(statementLines).set({ status: 'UNMATCHED', matchedTransactionId: null, updatedAt: now }).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId)));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

export async function excludeLineAction(formData: FormData): Promise<void> {
  await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  if (!(await loadPeriod(periodId))) return;
  const now = new Date().toISOString();
  await db.delete(reconciliationMatches).where(eq(reconciliationMatches.statementLineId, lineId));
  await db.update(statementLines).set({ status: 'EXCLUDED', matchedTransactionId: null, updatedAt: now }).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId)));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

export async function restoreLineAction(formData: FormData): Promise<void> {
  await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  if (!(await loadPeriod(periodId))) return;
  await db.update(statementLines).set({ status: 'UNMATCHED', updatedAt: new Date().toISOString() }).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId)));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

// ── Manual-mode clearing ──────────────────────────────────────────────────

export async function clearLineAction(formData: FormData): Promise<void> {
  await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  if (!(await loadPeriod(periodId))) return;
  const [line] = await db.select({ externalId: statementLines.externalId, matchedTransactionId: statementLines.matchedTransactionId }).from(statementLines).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId))).limit(1);
  if (!line) return;
  const txnId = line.matchedTransactionId ?? (line.externalId?.startsWith('manual:') ? line.externalId.slice(7) : null);
  if (!txnId) return;
  const now = new Date().toISOString();
  await db.delete(reconciliationMatches).where(eq(reconciliationMatches.statementLineId, lineId));
  await db.insert(reconciliationMatches).values({ id: randomUUID(), reconciliationPeriodId: periodId, statementLineId: lineId, transactionId: txnId, matchType: 'EXACT', score: 1, createdBy: 'manual', createdAt: now });
  await db.update(statementLines).set({ status: 'MATCHED', matchedTransactionId: txnId, updatedAt: now }).where(eq(statementLines.id, lineId));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

export async function unclearLineAction(formData: FormData): Promise<void> {
  await requireSession();
  const periodId = String(formData.get('periodId') ?? '');
  const lineId = String(formData.get('statementLineId') ?? '');
  if (!(await loadPeriod(periodId))) return;
  const now = new Date().toISOString();
  await db.delete(reconciliationMatches).where(eq(reconciliationMatches.statementLineId, lineId));
  await db.update(statementLines).set({ status: 'UNMATCHED', matchedTransactionId: null, updatedAt: now }).where(and(eq(statementLines.id, lineId), eq(statementLines.reconciliationPeriodId, periodId)));
  await recompute(periodId);
  revalidatePath(`/reconciliation/${periodId}`);
}

// ── Edit an existing period's statement dates + balances ──────────────────

/**
 * Edit a reconciliation period's statement window and beginning/ending balances
 * (the same fields as "New reconciliation"), then re-check against the ledger.
 * Recomputes the ledger closing as-of the (possibly new) end date, the
 * difference, and the status. Marks the period isManual=true so the engine
 * treats these as a user override and won't clobber them on the next sync/cron.
 */
export async function editReconciliationPeriodAction(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const periodId = String(formData.get('periodId') ?? '');
  const fromDate = String(formData.get('fromDate') ?? '').trim();
  const toDate = String(formData.get('toDate') ?? '').trim();
  const beginningRaw = String(formData.get('beginningBalance') ?? '').trim();
  const endingRaw = String(formData.get('endingBalance') ?? '').trim();

  const p = await loadPeriod(periodId);
  if (!p) return;
  if (!fromDate || !toDate || fromDate > toDate || endingRaw === '') return;

  const [acct] = await db
    .select({ normalBalance: chartOfAccounts.normalBalance })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, p.accountId))
    .limit(1);
  const normalBalance = acct?.normalBalance ?? 'debit';

  const ending = Number(endingRaw);
  const beginning = beginningRaw === '' ? null : Number(beginningRaw);
  if (!Number.isFinite(ending) || (beginning != null && !Number.isFinite(beginning))) return;

  const ledgerClosing = await ledgerBalanceAsOf(orgId, p.accountId, toDate, normalBalance);
  const difference = r2(ending - ledgerClosing);
  const status = Math.abs(difference) < 0.01 ? 'RECONCILED' : 'OPEN';
  const now = new Date().toISOString();

  await db
    .update(reconciliationPeriods)
    .set({
      startDate: fromDate,
      endDate: toDate,
      statementClosingBalance: ending.toFixed(2),
      ...(beginning != null
        ? { statementOpeningBalance: beginning.toFixed(2), ledgerOpeningBalance: beginning.toFixed(2) }
        : {}),
      ledgerClosingBalance: ledgerClosing.toFixed(2),
      difference: difference.toFixed(2),
      status,
      isManual: true,
      updatedAt: now,
    })
    .where(and(eq(reconciliationPeriods.id, periodId), eq(reconciliationPeriods.organizationId, orgId)));

  if (status === 'RECONCILED') await resolveReconciliationTask(periodId);
  revalidatePath('/reconciliation');
}

// ── Start a reconciliation by hand ────────────────────────────────────────

/**
 * Begin a reconciliation manually: capture the account, the statement period,
 * and the beginning/ending balances. Pre-fills the transactions in the window
 * as "cleared" (plus any carried-forward outstanding items as uncleared); the
 * user then clears/unclears until the difference is zero. Beginning balance
 * falls back to the prior reconciliation's ending when left blank.
 */
export async function createManualReconciliationAction(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const accountId = String(formData.get('accountId') ?? '');
  const fromDate = String(formData.get('fromDate') ?? '');
  const toDate = String(formData.get('toDate') ?? '');
  const beginningRaw = String(formData.get('beginningBalance') ?? '').trim();
  const endingRaw = String(formData.get('endingBalance') ?? '').trim();
  if (!accountId || !fromDate || !toDate || endingRaw === '' || fromDate > toDate) return;

  const [acct] = await db.select({ id: chartOfAccounts.id, normalBalance: chartOfAccounts.normalBalance }).from(chartOfAccounts).where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.organizationId, orgId))).limit(1);
  if (!acct) return;
  const normalSign = acct.normalBalance === 'credit' ? -1 : 1;

  // Already a period for this exact window? Open it instead of duplicating.
  const [existsRow] = await db.select({ id: reconciliationPeriods.id }).from(reconciliationPeriods).where(and(eq(reconciliationPeriods.organizationId, orgId), eq(reconciliationPeriods.accountId, accountId), eq(reconciliationPeriods.startDate, fromDate), eq(reconciliationPeriods.endDate, toDate))).limit(1);
  if (existsRow) {
    revalidatePath('/reconciliation');
    redirect(`/reconciliation/${existsRow.id}`);
  }

  let beginning: number;
  if (beginningRaw !== '') {
    beginning = Number(beginningRaw);
  } else {
    const [prior] = await db
      .select({ closing: reconciliationPeriods.statementClosingBalance })
      .from(reconciliationPeriods)
      .where(and(eq(reconciliationPeriods.organizationId, orgId), eq(reconciliationPeriods.accountId, accountId), lte(reconciliationPeriods.endDate, fromDate)))
      .orderBy(desc(reconciliationPeriods.endDate))
      .limit(1);
    beginning = prior?.closing != null ? Number(prior.closing) : 0;
  }
  const ending = Number(endingRaw);
  if (!Number.isFinite(beginning) || !Number.isFinite(ending)) return;

  const inWindow = await gatherLedgerTxns(orgId, accountId, fromDate, toDate);
  const since = await earliestPeriodStart(orgId, accountId);
  const cleared = await clearedTxnIds(orgId, accountId, null);
  const carried = since ? await gatherCarriedForward(orgId, accountId, since, fromDate, cleared) : [];

  const clearedSum = r2(inWindow.reduce((s, t) => s + t.signedAmount, 0));
  const ledgerClosing = r2(beginning + normalSign * clearedSum);
  const difference = r2(ending - ledgerClosing);
  const status = Math.abs(difference) < 0.01 ? 'RECONCILED' : 'OPEN';

  const periodId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(reconciliationPeriods).values({
    id: periodId,
    organizationId: orgId,
    accountId,
    startDate: fromDate,
    endDate: toDate,
    statementOpeningBalance: beginning.toFixed(2),
    statementClosingBalance: ending.toFixed(2),
    ledgerOpeningBalance: beginning.toFixed(2),
    ledgerClosingBalance: ledgerClosing.toFixed(2),
    difference: difference.toFixed(2),
    status,
    isManual: true,
    createdAt: now,
    updatedAt: now,
  });

  for (const t of inWindow) {
    const lineId = randomUUID();
    await db.insert(statementLines).values({ id: lineId, reconciliationPeriodId: periodId, organizationId: orgId, accountId, statementDate: t.date, descriptionRaw: t.description, amount: t.signedAmount.toFixed(2), runningBalance: null, externalId: `manual:${t.id}`, status: 'MATCHED', matchedTransactionId: t.id, createdAt: now, updatedAt: now });
    await db.insert(reconciliationMatches).values({ id: randomUUID(), reconciliationPeriodId: periodId, statementLineId: lineId, transactionId: t.id, matchType: 'EXACT', score: 1, createdBy: 'manual', createdAt: now });
  }
  for (const t of carried) {
    await db.insert(statementLines).values({ id: randomUUID(), reconciliationPeriodId: periodId, organizationId: orgId, accountId, statementDate: t.date, descriptionRaw: t.description, amount: t.signedAmount.toFixed(2), runningBalance: null, externalId: `manual:${t.id}`, status: 'UNMATCHED', matchedTransactionId: null, createdAt: now, updatedAt: now });
  }

  revalidatePath('/reconciliation');
  redirect(`/reconciliation/${periodId}`);
}
