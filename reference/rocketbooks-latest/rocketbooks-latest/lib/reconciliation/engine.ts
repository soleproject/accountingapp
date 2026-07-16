import 'server-only';
import { monthBounds, dayBefore, monthLabel, round2 } from './dates';
import { gatherSource } from './sources';
import {
  gatherLedgerTxns,
  ledgerBalanceAsOf,
  getAccountNormalBalance,
  clearedTxnIds,
  earliestPeriodStart,
  gatherCarriedForward,
} from './ledger';
import { matchSourceToLedger } from './match';
import { aiMatchAndExplain } from './ai-match';
import { persistReconciliation } from './persist';
import { readPreservation } from './preserve';
import type { Match, ReconcileResult } from './types';

/**
 * Reconcile one bank GL account for one month: gather the source of truth
 * (statement-authoritative, Plaid fallback) + the ledger, match transactions
 * (heuristic → AI), compute the closing-balance difference, set status, and
 * upsert the period. Idempotent and safely re-runnable.
 */
export async function reconcileAccountMonth(args: {
  organizationId: string;
  accountId: string;
  year: number;
  month: number;
  triggeredBy: 'cron' | 'statement-upload' | 'manual' | 'backfill';
  userId?: string | null;
}): Promise<ReconcileResult> {
  const { organizationId, accountId, year, month } = args;
  const { startDate, endDate } = monthBounds(year, month);

  const acct = await getAccountNormalBalance(accountId);
  if (!acct) return { status: 'SKIPPED', reason: 'account_not_found' };

  // monthBounds is only the lookup window to find a source; the actual period
  // reconciled is the source's own window (statement billing cycle, or month).
  const source = await gatherSource(organizationId, accountId, startDate, endDate, acct.normalBalance);
  if (!source) return { status: 'SKIPPED', reason: 'no_source' };
  const periodStart = source.periodStart;
  const periodEnd = source.periodEnd;

  // Preserve user edits (manual matches, EXCLUDED lines, force-reconcile) so an
  // engine re-run doesn't clobber them.
  const preservation = await readPreservation(organizationId, accountId, periodStart, periodEnd);
  // Never overwrite a hand-started (manual) reconciliation.
  if (preservation.isManual) return { status: 'SKIPPED', reason: 'manual_period', periodId: preservation.periodId ?? undefined };

  // Ledger match pool = this period's transactions + outstanding (uncleared)
  // items carried forward from earlier periods, so a check written last month
  // that clears on this statement gets matched and cleared.
  const inWindow = await gatherLedgerTxns(organizationId, accountId, periodStart, periodEnd);
  const sinceDate = await earliestPeriodStart(organizationId, accountId);
  const cleared = await clearedTxnIds(organizationId, accountId, preservation.periodId);
  const carried = sinceDate ? await gatherCarriedForward(organizationId, accountId, sinceDate, periodStart, cleared) : [];
  const pool = [...inWindow, ...carried];

  const ledgerClosing = await ledgerBalanceAsOf(organizationId, accountId, periodEnd, acct.normalBalance);
  const ledgerOpening = await ledgerBalanceAsOf(organizationId, accountId, dayBefore(periodStart), acct.normalBalance);

  const excluded = preservation.excludedExternalIds;

  // 1. Re-apply the user's manual matches first.
  const allMatches: Match[] = [];
  const usedSrc = new Set<string>();
  const usedTxn = new Set<string>();
  for (const s of source.lines) {
    const um = preservation.userMatches.get(s.externalId);
    if (um && !usedTxn.has(um.transactionId) && pool.some((t) => t.id === um.transactionId)) {
      allMatches.push({ sourceExternalId: s.externalId, transactionId: um.transactionId, matchType: um.matchType, score: um.score, createdBy: um.createdBy });
      usedSrc.add(s.externalId);
      usedTxn.add(um.transactionId);
    }
  }

  // 2. Heuristic match over the remainder (excluded lines never match).
  const heur = matchSourceToLedger(
    source.lines.filter((s) => !excluded.has(s.externalId) && !usedSrc.has(s.externalId)),
    pool.filter((t) => !usedTxn.has(t.id)),
  );
  allMatches.push(...heur.matches);

  const recomputeUnmatched = () => {
    const s2 = new Set(allMatches.map((m) => m.sourceExternalId));
    const t2 = new Set(allMatches.map((m) => m.transactionId));
    return {
      unmatchedSource: source.lines.filter((s) => !excluded.has(s.externalId) && !s2.has(s.externalId)),
      unmatchedLedger: pool.filter((t) => !t2.has(t.id)),
    };
  };
  let { unmatchedSource, unmatchedLedger } = recomputeUnmatched();

  const difference = source.closingBalance == null ? null : round2(source.closingBalance - ledgerClosing);

  // 3. AI pass when something is still unreconciled (bounds cost).
  let explanation = '';
  const needsAi = unmatchedSource.length > 0 || (difference != null && Math.abs(difference) >= 0.01);
  if (needsAi && process.env.OPENAI_API_KEY) {
    const ai = await aiMatchAndExplain({
      ctx: { userId: args.userId ?? null, orgId: organizationId, actor: 'reconcile', feature: 'reconcile-ai-match' },
      accountName: acct.name,
      period: monthLabel(year, month),
      sourceKind: source.kind,
      unmatchedSource,
      unmatchedLedger,
      difference,
      matchedCount: allMatches.length,
    });
    if (ai.matches.length > 0) {
      const t = new Set(allMatches.map((m) => m.transactionId));
      const s = new Set(allMatches.map((m) => m.sourceExternalId));
      allMatches.push(...ai.matches.filter((m) => !t.has(m.transactionId) && !s.has(m.sourceExternalId)));
      ({ unmatchedSource, unmatchedLedger } = recomputeUnmatched());
    }
    explanation = ai.explanation;
  }

  // 4. Status. Reconciled when every statement line is accounted for AND the
  // balances tie — either exactly, or because the residual difference is fully
  // explained by outstanding (uncleared) ledger items (the bank-rec identity:
  // statement − ledger = −sum(outstanding)). A force-reconciled period stays so.
  const balanced = difference != null && Math.abs(difference) < 0.01;
  const allSourceAccounted = unmatchedSource.length === 0;
  const outstandingSum = round2(unmatchedLedger.reduce((sum, t) => sum + t.signedAmount, 0));
  const outstandingExplained = difference != null && unmatchedLedger.length > 0 && Math.abs(difference + outstandingSum) < 0.01;
  const status: 'RECONCILED' | 'OPEN' = preservation.manuallyReconciled
    ? 'RECONCILED'
    : allSourceAccounted && (balanced || outstandingExplained)
      ? 'RECONCILED'
      : 'OPEN';

  if (!explanation) {
    explanation = templatedExplanation({
      status,
      sourceKind: source.kind,
      difference,
      matched: allMatches.length,
      unmatchedSource: unmatchedSource.length,
      unmatchedLedger: unmatchedLedger.length,
      closingKnown: source.closingBalance != null,
      outstandingExplained,
    });
  }

  const periodId = await persistReconciliation({
    organizationId,
    accountId,
    startDate: periodStart,
    endDate: periodEnd,
    sourceData: source,
    ledgerOpening,
    ledgerClosing,
    matches: allMatches,
    difference,
    status,
    explanation,
    excludedExternalIds: excluded,
    manuallyReconciled: preservation.manuallyReconciled,
  });

  return {
    status,
    periodId,
    sourceKind: source.kind,
    difference: difference ?? undefined,
    explanation,
    counts: {
      sourceLines: source.lines.length,
      ledgerTxns: pool.length,
      matched: allMatches.length,
      unmatchedSource: unmatchedSource.length,
      unmatchedLedger: unmatchedLedger.length,
    },
  };
}

function templatedExplanation(a: {
  status: 'RECONCILED' | 'OPEN';
  sourceKind: 'statement' | 'plaid';
  difference: number | null;
  matched: number;
  unmatchedSource: number;
  unmatchedLedger: number;
  closingKnown: boolean;
  outstandingExplained: boolean;
}): string {
  const src = a.sourceKind === 'statement' ? 'bank statement' : 'Plaid feed';
  if (a.status === 'RECONCILED') {
    if (a.outstandingExplained) {
      return `Reconciled: every ${src} line is matched, and the remaining $${Math.abs(a.difference ?? 0).toFixed(2)} difference is fully explained by ${a.unmatchedLedger} outstanding (uncleared) item(s) carried forward — they will clear on a future statement.`;
    }
    return `Reconciled against the ${src}: the closing balances match and all ${a.matched} transactions tie out.`;
  }
  if (!a.closingKnown) {
    return `Could not determine the closing balance from the ${src}, so the balance check is incomplete. ${a.matched} transactions matched; ${a.unmatchedSource} ${src} line(s) and ${a.unmatchedLedger} ledger entr(y/ies) are unmatched — review them.`;
  }
  const diff = a.difference ?? 0;
  const dir = diff > 0 ? 'higher than' : 'lower than';
  const parts = [
    `Out of balance by $${Math.abs(diff).toFixed(2)}: the ${src} closing balance is ${dir} the ledger.`,
  ];
  if (a.unmatchedSource > 0) parts.push(`${a.unmatchedSource} ${src} line(s) have no matching ledger entry (possible missing entries).`);
  if (a.unmatchedLedger > 0) parts.push(`${a.unmatchedLedger} ledger entr(y/ies) are not on the ${src} (possible outstanding/uncleared items or manual entries).`);
  return parts.join(' ');
}
