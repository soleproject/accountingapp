'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type Account = { id: string; accountNumber: string | null; accountName: string | null; normalBalance: string | null };
type Line = {
  lineId: string; jeId: string; date: string; jeMemo: string | null; lineMemo: string | null;
  sourceType: string | null; sourceId: string | null; accountId: string | null;
  accountNumber: string | null; accountName: string | null; contactName: string | null;
  debit: number; credit: number; runningBalance: number | null;
};
type Payload = { accounts: Account[]; selected: Account | null; fromDate: string; toDate: string; showReversals: boolean; rows: Line[]; totalDebitsAll: number; totalCreditsAll: number; net: number };

function fmt(n: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n); }
function sourceDocHref(sourceType: string | null, sourceId: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  if (sourceType === 'invoice') return `/invoices/${sourceId}`;
  if (sourceType === 'bill') return `/bills/${sourceId}`;
  if (sourceType === 'transaction') return `/transactions/${sourceId}`;
  if (sourceType === 'receipt' || sourceType === 'receipt-match') return `/receipts/${sourceId}`;
  return null;
}
function sourceDocLabel(sourceType: string | null): string {
  if (!sourceType) return 'manual';
  if (sourceType === 'receipt-match' || sourceType === 'receipt') return 'Receipt';
  return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
}

export function JournalEntriesClient({ query }: { query: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPayload(null); setError(false);
    fetch(`/api/journal-entries/summary${query}`, { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`)))
      .then((data: Payload) => { if (!cancelled) setPayload(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [query]);

  if (error) return <p className="text-sm text-amber-600">Journal entries are still loading. Refresh if this persists.</p>;
  if (!payload) return <JournalSkeleton />;
  const { accounts, selected, fromDate, toDate, showReversals, rows, totalDebitsAll, totalCreditsAll, net } = payload;
  return (
    <>
      <form className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Account</label>
          <select name="accountId" defaultValue={selected?.id ?? ''} className="min-w-[280px] rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— All accounts —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
          </select>
        </div>
        <label className="flex flex-col gap-1"><span className="text-xs text-zinc-500">From</span><input type="date" name="from" defaultValue={fromDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-zinc-500">To</span><input type="date" name="to" defaultValue={toDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
        <label className="flex h-8 cursor-pointer items-center gap-1.5 self-end rounded-md border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"><input type="checkbox" name="reversals" value="show" defaultChecked={showReversals} className="h-3.5 w-3.5" /><span>Show reversals</span></label>
        <button type="submit" className="h-8 rounded-md border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Apply</button>
      </form>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total debits" value={fmt(totalDebitsAll)} />
        <Stat label="Total credits" value={fmt(totalCreditsAll)} />
        <Stat label="Net (debits − credits)" value={fmt(net)} tone={Math.abs(net) < 0.005 ? 'zero' : net > 0 ? 'pos' : 'neg'} />
      </section>
      {selected && <div className="text-sm text-zinc-600 dark:text-zinc-400">Showing <strong>{selected.accountNumber} · {selected.accountName}</strong> from {fromDate} to {toDate}</div>}
      <JournalTable rows={rows} selected={!!selected} fromDate={fromDate} toDate={toDate} />
    </>
  );
}

function JournalSkeleton() {
  return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}</div>;
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'zero' | 'pos' | 'neg' }) {
  const toneClass = tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-zinc-900 dark:text-zinc-100';
  return <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"><div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div></div>;
}
function JournalTable({ rows, selected, fromDate, toDate }: { rows: Line[]; selected: boolean; fromDate: string; toDate: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900"><tr><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>{!selected && <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>}<th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Source</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Reference</th><th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Debit</th><th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Credit</th>{selected && <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Balance</th>}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={selected ? 8 : 7} className="px-4 py-8 text-center text-zinc-500">No journal entry lines in this period.</td></tr>}
          {rows.map((e) => {
            const docHref = sourceDocHref(e.sourceType, e.sourceId);
            return <tr key={e.lineId} className="border-t border-zinc-100 dark:border-zinc-800"><td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={`/journal-entries/${e.jeId}`} prefetch={false} className="hover:underline">{e.date}</Link></td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{e.lineMemo ?? e.jeMemo ?? '—'}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{e.contactName ?? '—'}</td>{!selected && <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{e.accountId ? <Link href={`/reports/account/${e.accountId}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`} prefetch={false} className="hover:underline">{e.accountNumber} · {e.accountName}</Link> : '—'}</td>}<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{docHref ? <Link href={docHref} prefetch={false} className="text-blue-600 hover:underline dark:text-blue-400">{sourceDocLabel(e.sourceType)}</Link> : <span className="text-zinc-400">{sourceDocLabel(e.sourceType)}</span>}</td><td className="px-4 py-2 font-mono text-xs text-zinc-500" title={e.jeId}>{e.jeId.slice(0, 8)}</td><td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{e.debit > 0 ? fmt(e.debit) : ''}</td><td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{e.credit > 0 ? fmt(e.credit) : ''}</td>{selected && <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{e.runningBalance != null ? fmt(e.runningBalance) : ''}</td>}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
