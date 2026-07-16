import Link from 'next/link';
import { eq, and, desc, asc, sql, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, journalEntries, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import { detectPeriodPreset, getPeriodPresets } from '@/lib/reports/date-presets';
import { PeriodPresetSelect } from '@/components/reports/PeriodPresetSelect';
import { generalLedgerBasisFilter, resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { ExportPdfButton } from '@/components/reports/ExportPdfButton';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

function sourceDocHref(sourceType: string | null, sourceId: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  switch (sourceType) {
    case 'invoice':
      return `/invoices/${sourceId}`;
    case 'bill':
      return `/bills/${sourceId}`;
    case 'transaction':
      return `/transactions/${sourceId}`;
    default:
      return null;
  }
}

function sourceDocLabel(sourceType: string | null): string {
  if (!sourceType) return '';
  return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
}

interface PageProps {
  searchParams: Promise<{ accountId?: string; from?: string; to?: string; basis?: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function GeneralLedgerPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { accountId, from, to, basis: basisParam } = await searchParams;
  const fromDate = safeIsoDate(from, yearStartIso());
  const toDate = safeIsoDate(to, todayIso());
  const basis = await resolveBasis(orgId, basisParam);

  const accounts = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType, normalBalance: chartOfAccounts.normalBalance })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  let entries: Array<{
    id: string;
    date: string | null;
    debit: number;
    credit: number;
    memo: string | null;
    accountName: string | null;
    contactName: string | null;
    journalEntryId: string | null;
    jeMemo: string | null;
    sourceType: string | null;
    sourceId: string | null;
    runningBalance: number;
  }> = [];
  let totalDebit = 0;
  let totalCredit = 0;

  const selected = accounts.find((a) => a.id === accountId);

  if (accountId) {
    const rows = await db
      .select({
        id: generalLedger.id,
        date: sql<string>`${generalLedger.date}::date::text`,
        debit: generalLedger.debit,
        credit: generalLedger.credit,
        memo: generalLedger.memo,
        accountName: chartOfAccounts.accountName,
        contactName: contacts.contactName,
        journalEntryId: generalLedger.journalEntryId,
        jeMemo: journalEntries.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      })
      .from(generalLedger)
      .leftJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(generalLedger.contactId, contacts.id))
      .leftJoin(journalEntries, eq(generalLedger.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          eq(generalLedger.accountId, accountId),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${toDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .orderBy(asc(generalLedger.date), desc(generalLedger.createdAt))
      .limit(500);

    const isDebitNormal = selected?.normalBalance === 'debit';
    let running = 0;
    entries = rows.map((r) => {
      const debit = Number(r.debit ?? 0);
      const credit = Number(r.credit ?? 0);
      running += isDebitNormal ? debit - credit : credit - debit;
      return { ...r, debit, credit, runningBalance: running };
    });
    totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">General Ledger</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Drill down by account</p>
        </div>
        <div className="flex items-center gap-3">
          <BasisToggle basis={basis} />
          <ExportPdfButton
            href={(() => {
              const qs = new URLSearchParams();
              qs.set('from', fromDate);
              qs.set('to', toDate);
              qs.set('basis', basis);
              if (accountId) qs.set('accountId', accountId);
              return `/api/reports/general-ledger/pdf?${qs.toString()}`;
            })()}
            label={`Export PDF${accountId ? '' : ' (all accounts)'}`}
            disabled={await hasActiveDemoTrial(orgId)}
          />
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-3">
        {basis !== 'accrual' && <input type="hidden" name="basis" value={basis} />}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Account</label>
          <select
            name="accountId"
            defaultValue={accountId ?? ''}
            className="min-w-[280px] rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">— Pick an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Range</label>
          <PeriodPresetSelect
            presets={getPeriodPresets()}
            currentKey={detectPeriodPreset(fromDate, toDate)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">From</label>
          <input type="date" name="from" defaultValue={fromDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">To</label>
          <input type="date" name="to" defaultValue={toDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <button type="submit" className="h-8 rounded-md border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Apply
        </button>
      </form>

      {selected && (
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          Showing <strong>{selected.accountNumber} · {selected.accountName}</strong> from {fromDate} to {toDate}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Source</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Reference</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Debit</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Credit</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Balance</th>
            </tr>
          </thead>
          <tbody>
            {!accountId && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  Pick an account above to see its ledger entries.
                </td>
              </tr>
            )}
            {accountId && entries.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  No entries in this period.
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const docHref = sourceDocHref(e.sourceType, e.sourceId);
              return (
                <tr key={e.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{e.date}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{e.memo ?? e.jeMemo ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{e.contactName ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {docHref ? (
                      <Link href={docHref} className="text-blue-600 hover:underline dark:text-blue-400">
                        {sourceDocLabel(e.sourceType)}
                      </Link>
                    ) : (
                      <span className="text-zinc-400">{sourceDocLabel(e.sourceType) || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500" title={e.journalEntryId ?? ''}>
                    {e.journalEntryId ? e.journalEntryId.slice(0, 8) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {e.debit > 0 ? fmt(e.debit) : ''}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {e.credit > 0 ? fmt(e.credit) : ''}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {fmt(e.runningBalance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {entries.length > 0 && (
            <tfoot className="bg-zinc-50 dark:bg-zinc-900">
              <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
                <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Totals · {entries.length} {entries.length === 500 ? '(capped)' : ''}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(totalDebit)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(totalCredit)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">
                  {entries.length > 0 ? fmt(entries[entries.length - 1].runningBalance) : ''}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
