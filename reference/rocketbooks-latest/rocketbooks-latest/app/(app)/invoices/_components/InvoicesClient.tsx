'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InvoiceRowActions } from './InvoiceRowActions';

type InvoiceFilter = 'outstanding' | 'overdue' | 'due30' | 'collected_month';
type Row = { id: string; invoiceNumber: string | null; invoiceDate: string; dueDate: string | null; status: string | null; posted: boolean | null; memo: string | null; contactName: string | null; journalEntryId: string | null; invoiceTotal: number; outstanding: number; isOverdue: boolean; statusLabel: string };
type Payload = { page: number; pageCount: number; totalCount: number; filter: InvoiceFilter | null; today: string; in30: string; monthStart: string; rows: Row[]; openCount: number; outstandingTotal: number; overdueTotal: number; dueIn30Total: number; collectedThisMonth: number; buckets: { current: number; b30: number; b60: number; b90: number; b90plus: number }; agingTotal: number };
const FILTER_LABELS: Record<InvoiceFilter, string> = { outstanding: 'Outstanding', overdue: 'Overdue', due30: 'Due in next 30 days', collected_month: 'Collected this month' };
const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const fmtCompact = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: n >= 10000 ? 1 : 2 }).format(n);

export function InvoicesClient({ query }: { query: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPayload(null); setError(false);
    fetch(`/api/invoices/summary${query}`, { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`)))
      .then((data: Payload) => { if (!cancelled) setPayload(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [query]);
  if (error) return <p className="text-sm text-amber-600">Invoices are still loading. Refresh if this persists.</p>;
  if (!payload) return <InvoicesSkeleton />;
  const p = payload;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Outstanding" value={p.outstandingTotal} tone="zinc" hint={`${p.openCount} unpaid`} filter="outstanding" activeFilter={p.filter} />
        <Tile label="Overdue" value={p.overdueTotal} tone={p.overdueTotal > 0 ? 'red' : 'zinc'} hint={p.overdueTotal > 0 ? 'Past due' : 'Nothing past due'} filter="overdue" activeFilter={p.filter} />
        <Tile label="Due in next 30 days" value={p.dueIn30Total} tone="amber" hint={`${p.today} → ${p.in30}`} filter="due30" activeFilter={p.filter} />
        <Tile label="Collected this month" value={p.collectedThisMonth} tone="emerald" hint={`Since ${p.monthStart}`} filter="collected_month" activeFilter={p.filter} />
      </div>
      {p.filter && <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"><span>Filtering to <strong>{FILTER_LABELS[p.filter]}</strong> · {p.totalCount.toLocaleString()} match{p.totalCount === 1 ? '' : 'es'}</span><Link href="/invoices" prefetch={false} className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Clear filter</Link></div>}
      {p.agingTotal > 0 && <AgingBar buckets={p.buckets} agingTotal={p.agingTotal} />}
      <InvoicesTable rows={p.rows} today={p.today} />
      {p.pageCount > 1 && <nav className="flex items-center gap-2 text-sm">{p.page > 1 && <a href={`?page=${p.page - 1}${p.filter ? `&filter=${p.filter}` : ''}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">← Previous</a>}{p.page < p.pageCount && <a href={`?page=${p.page + 1}${p.filter ? `&filter=${p.filter}` : ''}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Next →</a>}</nav>}
    </>
  );
}
function InvoicesSkeleton() { return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}</div>; }
function Tile({ label, value, tone, hint, filter, activeFilter }: { label: string; value: number; tone: 'zinc' | 'red' | 'amber' | 'emerald'; hint?: string; filter: InvoiceFilter; activeFilter: InvoiceFilter | null }) {
  const isActive = activeFilter === filter;
  const palette = { zinc: 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950', red: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20', amber: 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20', emerald: 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20' }[tone];
  return <Link href={isActive ? '/invoices' : `/invoices?filter=${filter}`} prefetch={false} aria-pressed={isActive} className={`block rounded-lg border p-4 transition-shadow hover:shadow-md ${palette} ${isActive ? 'ring-2 ring-offset-1 dark:ring-offset-zinc-950 ring-zinc-400' : ''}`}><div className="text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCompact(value)}</div>{hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}</Link>;
}
function AgingBar({ buckets, agingTotal }: { buckets: Payload['buckets']; agingTotal: number }) {
  return <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"><header className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">A/R aging</h2><span className="text-xs text-zinc-500">Total {fmt(agingTotal)}</span></header><div className="flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">{[{ amt: buckets.current, cls: 'bg-emerald-400' }, { amt: buckets.b30, cls: 'bg-amber-400' }, { amt: buckets.b60, cls: 'bg-orange-500' }, { amt: buckets.b90, cls: 'bg-red-500' }, { amt: buckets.b90plus, cls: 'bg-red-700' }].map((seg, i) => seg.amt > 0 ? <div key={i} className={seg.cls} style={{ width: `${(seg.amt / agingTotal) * 100}%` }} title={fmt(seg.amt)} /> : null)}</div></section>;
}
function InvoicesTable({ rows }: { rows: Row[]; today: string }) {
  return <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"><table className="w-full text-sm"><thead className="bg-zinc-50 text-left dark:bg-zinc-900"><tr><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Number</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Customer</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th><th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Outstanding</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">JE</th><th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th><th className="px-4 py-2 text-right"><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-zinc-500">No invoices.</td></tr>}{rows.map((i) => <tr key={i.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"><td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={`/invoices/${i.id}`} prefetch={false} className="hover:underline">{i.invoiceDate}</Link></td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{i.invoiceNumber ?? '—'}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{i.contactName ?? '—'}</td><td className="px-4 py-2"><StatusPill status={i.statusLabel} overdue={i.isOverdue} /></td><td className="px-4 py-2 text-right tabular-nums">{i.outstanding > 0 ? <span className={i.isOverdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'}>{fmt(i.outstanding)}</span> : <span className="text-zinc-400">—</span>}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{i.journalEntryId ? <Link href={`/journal-entries/${i.journalEntryId}`} prefetch={false} className="text-xs underline">View</Link> : '—'}</td><td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{i.memo ?? '—'}</td><td className="px-4 py-2"><InvoiceRowActions invoiceId={i.id} invoiceLabel={i.invoiceNumber ?? `#${i.id.slice(0, 8)}`} posted={!!i.posted} /></td></tr>)}</tbody></table></div>;
}
function StatusPill({ status, overdue }: { status: string; overdue: boolean }) {
  const key = overdue ? 'overdue' : status.toLowerCase();
  const cls = { draft: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300', open: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200', paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200', void: 'bg-zinc-200 text-zinc-600 line-through dark:bg-zinc-800 dark:text-zinc-500', overdue: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' }[key] ?? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cls}`}>{overdue ? 'overdue' : status}</span>;
}
