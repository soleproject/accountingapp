import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, asc, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  reconciliationPeriods,
  statementLines,
  reconciliationMatches,
  transactions,
  chartOfAccounts,
  imports,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { ReconcileWatcher } from './_components/ReconcileWatcher';
import { clearedTxnIds, earliestPeriodStart, gatherCarriedForward } from '@/lib/reconciliation/ledger';
import {
  manualMatchAction,
  unmatchLineAction,
  excludeLineAction,
  restoreLineAction,
  clearLineAction,
  unclearLineAction,
} from '../_actions';

export const dynamic = 'force-dynamic';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
function signedLedger(amount: number | null, type: string | null): number {
  return (type === 'deposit' ? 1 : -1) * Math.abs(amount ?? 0);
}

export default async function ReconciliationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  const [period] = await db
    .select({
      id: reconciliationPeriods.id,
      accountId: reconciliationPeriods.accountId,
      startDate: reconciliationPeriods.startDate,
      endDate: reconciliationPeriods.endDate,
      status: reconciliationPeriods.status,
      isManual: reconciliationPeriods.isManual,
      statementOpening: reconciliationPeriods.statementOpeningBalance,
      statementClosing: reconciliationPeriods.statementClosingBalance,
      ledgerOpening: reconciliationPeriods.ledgerOpeningBalance,
      ledgerClosing: reconciliationPeriods.ledgerClosingBalance,
      difference: reconciliationPeriods.difference,
      aiExplanation: reconciliationPeriods.aiExplanation,
      accountName: chartOfAccounts.accountName,
    })
    .from(reconciliationPeriods)
    .leftJoin(chartOfAccounts, eq(chartOfAccounts.id, reconciliationPeriods.accountId))
    .where(and(eq(reconciliationPeriods.id, id), eq(reconciliationPeriods.organizationId, orgId)))
    .limit(1);
  if (!period) notFound();

  const lines = await db
    .select({
      id: statementLines.id,
      statementDate: statementLines.statementDate,
      descriptionRaw: statementLines.descriptionRaw,
      amount: statementLines.amount,
      status: statementLines.status,
      matchedTransactionId: statementLines.matchedTransactionId,
      matchType: reconciliationMatches.matchType,
      score: reconciliationMatches.score,
    })
    .from(statementLines)
    .leftJoin(reconciliationMatches, eq(reconciliationMatches.statementLineId, statementLines.id))
    .where(eq(statementLines.reconciliationPeriodId, id))
    .orderBy(asc(statementLines.statementDate));

  const diff = period.difference != null ? Number(period.difference) : null;
  const reconciled = period.status === 'RECONCILED';
  const balanced = diff != null && Math.abs(diff) < 0.01;

  const header = (
    <header className="flex flex-col gap-1">
      <Link href="/reconciliation" className="text-sm text-blue-600 hover:underline dark:text-blue-400">← Reconciliation</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{period.accountName ?? 'Account'}</h1>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${reconciled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'}`}>{period.status}</span>
        {period.isManual && <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Manual</span>}
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{period.startDate} → {period.endDate}</p>
      <ReconcileWatcher reconciled={reconciled} accountName={period.accountName} />
    </header>
  );

  // ── Manual (clear-the-transactions) reconciliation ──────────────────────
  if (period.isManual) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <BalanceCard label="Ending balance (statement)" value={period.statementClosing} sub={`Beginning ${fmt(period.statementOpening != null ? Number(period.statementOpening) : null)}`} />
          <BalanceCard label="Cleared balance" value={period.ledgerClosing} sub="Beginning + cleared transactions" />
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Difference</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt(diff)}</div>
            <div className="mt-1 text-xs text-zinc-500">{balanced ? 'Reconciled — fully cleared' : 'Clear transactions until this is $0.00'}</div>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium dark:border-zinc-800 dark:bg-zinc-900">
            Transactions — check off what appears on the statement ({lines.length})
          </header>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 w-10">Cleared</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {lines.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-zinc-500">No transactions in this period.</td></tr>}
              {lines.map((l) => {
                const cleared = l.status === 'MATCHED';
                return (
                  <tr key={l.id} className={cleared ? '' : 'bg-amber-50/40 dark:bg-amber-950/10'}>
                    <td className="px-4 py-2 text-center">{cleared ? <span className="text-emerald-600 dark:text-emerald-400">✓</span> : <span className="text-zinc-300 dark:text-zinc-600">○</span>}</td>
                    <td className="px-4 py-2 tabular-nums text-zinc-500">{l.statementDate}</td>
                    <td className="px-4 py-2">{l.descriptionRaw || '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(Number(l.amount))}</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end">
                        {cleared
                          ? <FormButton action={unclearLineAction} periodId={period.id} lineId={l.id} label="Unclear" />
                          : <FormButton action={clearLineAction} periodId={period.id} lineId={l.id} label="Clear" primary />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    );
  }

  // ── Statement / Plaid reconciliation ────────────────────────────────────
  const [inWindowLedger, [stmtImport]] = await Promise.all([
    db
      .select({ id: transactions.id, date: transactions.date, description: transactions.description, amount: transactions.amount, type: transactions.type, importId: transactions.importId })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), eq(transactions.accountId, period.accountId), gte(transactions.date, period.startDate), lte(transactions.date, period.endDate)))
      .orderBy(asc(transactions.date)),
    db
      .select({ id: imports.id })
      .from(imports)
      .where(and(eq(imports.organizationId, orgId), eq(imports.accountId, period.accountId), eq(imports.importMethod, 'bank_statement'), gte(imports.endDate, period.startDate), lte(imports.endDate, period.endDate)))
      .limit(1),
  ]);

  const matchedTxnIds = new Set(lines.map((l) => l.matchedTransactionId).filter((x): x is string => !!x));
  const since = await earliestPeriodStart(orgId, period.accountId);
  const clearedElsewhere = await clearedTxnIds(orgId, period.accountId, id);
  const carried = since ? await gatherCarriedForward(orgId, period.accountId, since, period.startDate, clearedElsewhere) : [];
  const outstanding = [
    ...inWindowLedger.filter((t) => !matchedTxnIds.has(t.id)).map((t) => ({ id: t.id, date: t.date, description: t.description ?? '', signed: signedLedger(t.amount, t.type), manual: t.importId == null, carried: false })),
    ...carried.map((t) => ({ id: t.id, date: t.date, description: t.description, signed: t.signedAmount, manual: t.isManual, carried: true })),
  ];
  const sourceLabel = stmtImport ? 'Bank statement' : 'Plaid';
  const matchOptions = outstanding.map((t) => ({ id: t.id, label: `${t.date}  ${t.description.slice(0, 36)}  ${fmt(t.signed)}` }));

  return (
    <div className="flex flex-col gap-5">
      {header}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <BalanceCard label="Statement closing" value={period.statementClosing} sub={`Opening ${fmt(period.statementOpening != null ? Number(period.statementOpening) : null)}`} />
        <BalanceCard label="Ledger closing" value={period.ledgerClosing} sub={`Opening ${fmt(period.ledgerOpening != null ? Number(period.ledgerOpening) : null)}`} />
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Difference</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${diff != null && Math.abs(diff) > 0.01 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{diff != null ? fmt(diff) : '—'}</div>
          <div className="mt-1 text-xs text-zinc-500">statement − ledger</div>
        </div>
      </div>

      <span className="w-fit rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Source: {sourceLabel}</span>

      {period.aiExplanation && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">AI summary</div>
          {period.aiExplanation}
        </div>
      )}

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium dark:border-zinc-800 dark:bg-zinc-900">{sourceLabel} lines ({lines.length})</header>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2">Match</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {lines.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-zinc-500">No source lines.</td></tr>}
            {lines.map((l) => (
              <tr key={l.id} className={l.status === 'EXCLUDED' ? 'opacity-60' : ''}>
                <td className="px-4 py-2 tabular-nums text-zinc-500">{l.statementDate}</td>
                <td className="px-4 py-2">{l.descriptionRaw ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmt(Number(l.amount))}</td>
                <td className="px-4 py-2">
                  {l.status === 'MATCHED' ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{l.matchType ?? 'MATCHED'}{l.score != null ? ` ${Math.round(Number(l.score) * 100)}%` : ''}</span>
                  ) : (
                    <span className={`rounded px-1.5 py-0.5 text-xs ${l.status === 'EXCLUDED' ? 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>{l.status}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center justify-end gap-2">
                    {l.status === 'MATCHED' && <FormButton action={unmatchLineAction} periodId={period.id} lineId={l.id} label="Unmatch" />}
                    {l.status === 'UNMATCHED' && (
                      <>
                        {matchOptions.length > 0 && (
                          <form action={manualMatchAction} className="flex items-center gap-1">
                            <input type="hidden" name="periodId" value={period.id} />
                            <input type="hidden" name="statementLineId" value={l.id} />
                            <select name="transactionId" required defaultValue="" className="max-w-[14rem] rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950">
                              <option value="" disabled>Match to…</option>
                              {matchOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                            </select>
                            <button type="submit" className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">Match</button>
                          </form>
                        )}
                        <FormButton action={excludeLineAction} periodId={period.id} lineId={l.id} label="Exclude" />
                      </>
                    )}
                    {l.status === 'EXCLUDED' && <FormButton action={restoreLineAction} periodId={period.id} lineId={l.id} label="Restore" />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium dark:border-zinc-800 dark:bg-zinc-900">Outstanding — in ledger, not on the {sourceLabel.toLowerCase()} ({outstanding.length})</header>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {outstanding.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-zinc-500">Nothing outstanding — every ledger entry is matched.</td></tr>}
            {outstanding.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2 tabular-nums text-zinc-500">{t.date}</td>
                <td className="px-4 py-2">{t.description || '—'}</td>
                <td className="px-4 py-2 text-xs text-zinc-500">{t.manual ? 'manual' : 'imported'}{t.carried ? ' · carried fwd' : ''}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmt(t.signed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function FormButton({ action, periodId, lineId, label, primary }: { action: (fd: FormData) => Promise<void>; periodId: string; lineId: string; label: string; primary?: boolean }) {
  return (
    <form action={action}>
      <input type="hidden" name="periodId" value={periodId} />
      <input type="hidden" name="statementLineId" value={lineId} />
      <button type="submit" className={primary ? 'rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200' : 'rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'}>{label}</button>
    </form>
  );
}

function BalanceCard({ label, value, sub }: { label: string; value: string | null; sub: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value != null ? fmt(Number(value)) : '—'}</div>
      <div className="mt-1 text-xs text-zinc-500">{sub}</div>
    </div>
  );
}
