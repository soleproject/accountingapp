'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardSummary } from '../_lib/loadDashboardSummary';

type LoadState = 'loading' | 'ready' | 'error';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-US');

function formatMoney(value: number | null | undefined) {
  if (value == null) return '—';
  return money.format(value);
}

function maxPositive(values: number[]) {
  return Math.max(1, ...values.map((value) => Math.abs(value)));
}

function KpiCard({ label, value, detail, href, accent }: { label: string; value: string; detail: string; href: string; accent: string }) {
  return (
    <Link prefetch={false} href={href} className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg hover:shadow-blue-950/10 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700">
      <div className={`h-1.5 w-12 rounded-full ${accent}`} />
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{value}</p>
      <p className="mt-2 text-sm leading-5 text-zinc-600 dark:text-zinc-300">{detail}</p>
    </Link>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="h-1.5 w-12 rounded-full bg-zinc-200 dark:bg-zinc-700" />
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="mt-3 h-8 w-32 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
      <div className="mt-3 h-4 w-44 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
    </div>
  );
}

function CashActivityChart({ rows }: { rows: DashboardSummary['cashActivity'] }) {
  const max = maxPositive(rows.flatMap((row) => [row.incoming, row.outgoing]));
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Cash activity</p>
          <h3 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-white">Last 30 days</h3>
        </div>
        <div className="flex gap-3 text-xs text-zinc-500 dark:text-zinc-400"><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" />In</span><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-500" />Out</span></div>
      </div>
      <div className="mt-6 flex h-48 items-end gap-3" aria-label="Cash activity chart" role="img">
        {(rows.length ? rows : [{ label: 'No data', incoming: 0, outgoing: 0, net: 0 }]).map((row) => (
          <div key={row.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex h-36 w-full items-end justify-center gap-1 rounded-xl bg-zinc-50 px-2 py-2 dark:bg-zinc-950">
              <span className="w-3 rounded-t bg-emerald-500" style={{ height: `${Math.max(4, (row.incoming / max) * 100)}%` }} title={`Incoming ${formatMoney(row.incoming)}`} />
              <span className="w-3 rounded-t bg-rose-500" style={{ height: `${Math.max(4, (row.outgoing / max) * 100)}%` }} title={`Outgoing ${formatMoney(row.outgoing)}`} />
            </div>
            <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{row.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VolumeChart({ rows }: { rows: DashboardSummary['transactionVolume'] }) {
  const max = maxPositive(rows.flatMap((row) => [row.deposits, row.withdrawals, row.toClassify]));
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Transaction volume</p>
      <h3 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-white">This month vs last month</h3>
      <div className="mt-6 space-y-4" aria-label="Transaction volume chart" role="img">
        {(rows.length ? rows : [{ label: 'No data', deposits: 0, withdrawals: 0, toClassify: 0 }]).map((row) => (
          <div key={row.label}>
            <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-zinc-800 dark:text-zinc-100">{row.label}</span><span className="text-zinc-500 dark:text-zinc-400">{number.format(row.deposits + row.withdrawals)} txns</span></div>
            <div className="space-y-1.5">
              <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${(row.deposits / max) * 100}%` }} /></div>
              <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-2 rounded-full bg-blue-500" style={{ width: `${(row.withdrawals / max) * 100}%` }} /></div>
              <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-2 rounded-full bg-amber-500" style={{ width: `${(row.toClassify / max) * 100}%` }} /></div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400"><span>Green deposits</span><span>Blue withdrawals</span><span>Amber to classify</span></div>
    </div>
  );
}

function AgingChart({ rows }: { rows: DashboardSummary['aging'] }) {
  const max = maxPositive(rows.flatMap((row) => [row.ar, row.ap]));
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6 lg:col-span-2">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Aging</p>
      <h3 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-white">Receivables vs payables</h3>
      <div className="mt-6 grid gap-3" aria-label="AR and AP aging chart" role="img">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[4rem_1fr] items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{row.label}</span>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2"><div className="h-2 rounded-full bg-blue-500" style={{ width: `${Math.max(2, (row.ar / max) * 100)}%` }} /><span className="text-xs text-zinc-500">AR {formatMoney(row.ar)}</span></div>
              <div className="flex items-center gap-2"><div className="h-2 rounded-full bg-purple-500" style={{ width: `${Math.max(2, (row.ap / max) * 100)}%` }} /><span className="text-xs text-zinc-500">AP {formatMoney(row.ap)}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardSummaryClient({ initialSummary = null }: { initialSummary?: DashboardSummary | null }) {
  const [fallbackState, setFallbackState] = useState<LoadState>('loading');
  const [fallbackSummary, setFallbackSummary] = useState<DashboardSummary | null>(null);
  const summary = initialSummary ?? fallbackSummary;
  const state: LoadState = initialSummary !== null ? 'ready' : fallbackState;

  useEffect(() => {
    if (initialSummary !== null) return;
    let cancelled = false;
    fetch('/api/dashboard/summary', { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`)))
      .then((data: DashboardSummary) => { if (!cancelled) { setFallbackSummary(data); setFallbackState('ready'); } })
      .catch(() => { if (!cancelled) setFallbackState('error'); });
    return () => { cancelled = true; };
  }, [initialSummary]);

  const kpis = useMemo(() => summary ? [
    { label: 'Cash activity', value: summary.cash.cashBalance == null ? formatMoney(summary.cash.net30) : formatMoney(summary.cash.cashBalance), detail: summary.cash.cashBalance == null ? `Net last 30 days · In ${formatMoney(summary.cash.incoming30)} / Out ${formatMoney(summary.cash.outgoing30)}` : `Net 30 days ${formatMoney(summary.cash.net30)}`, href: '/reports', accent: 'bg-emerald-500' },
    { label: 'Outstanding invoices', value: formatMoney(summary.ar.outstandingInvoices), detail: `${summary.ar.openInvoiceCount} open · ${formatMoney(summary.ar.overdueInvoices)} overdue · ${formatMoney(summary.ar.dueSoonInvoices)} due soon`, href: '/invoices?filter=outstanding', accent: 'bg-blue-500' },
    { label: 'Outstanding bills', value: formatMoney(summary.ap.outstandingBills), detail: `${summary.ap.openBillCount} open · ${formatMoney(summary.ap.overdueBills)} overdue · ${formatMoney(summary.ap.dueSoonBills)} due soon`, href: '/bills?filter=outstanding', accent: 'bg-purple-500' },
    { label: 'Transactions to classify', value: formatMoney(summary.transactions.transactionsToClassifyAmount), detail: `${number.format(summary.transactions.transactionsToClassify)} items · ${number.format(summary.transactions.depositsToReview)} deposits · ${number.format(summary.transactions.aiToVerify)} AI checks`, href: '/transactions?reviewed=0&unreviewed=1&deposits=0&withdrawals=1&filter=to_review', accent: 'bg-amber-500' },
  ] : [], [summary]);

  if (state === 'loading') {
    return <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><LoadingCard label="Cash activity" /><LoadingCard label="Outstanding invoices" /><LoadingCard label="Outstanding bills" /><LoadingCard label="Transactions to classify" /></section>;
  }

  if (state === 'error' || !summary) {
    return <section className="rounded-3xl border border-zinc-200 bg-white p-5 text-sm text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">Dashboard cards are loading behind the scenes. You can keep working from the links below.</section>;
  }

  return (
    <>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => <KpiCard key={kpi.label} {...kpi} />)}
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <CashActivityChart rows={summary.cashActivity} />
        <VolumeChart rows={summary.transactionVolume} />
        <AgingChart rows={summary.aging} />
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Work queue</p>
          <h3 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-white">Clean books next</h3>
          <div className="mt-5 grid gap-3">
            <Link prefetch={false} href="/transactions?deposits=1&withdrawals=0&reviewed=0&unreviewed=1&filter=to_review" className="rounded-2xl border border-zinc-200 p-4 hover:border-blue-300 dark:border-zinc-800 dark:hover:border-blue-700"><span className="font-semibold">Review deposits</span><span className="float-right text-zinc-500">{number.format(summary.transactions.depositsToReview)}</span></Link>
            <Link prefetch={false} href="/transactions?filter=to_verify&deposits=1&withdrawals=1" className="rounded-2xl border border-zinc-200 p-4 hover:border-blue-300 dark:border-zinc-800 dark:hover:border-blue-700"><span className="font-semibold">Verify AI categorized</span><span className="float-right text-zinc-500">{number.format(summary.transactions.aiToVerify)}</span></Link>
            <Link prefetch={false} href="/transactions?reviewed=0&unreviewed=1&deposits=0&withdrawals=1&filter=to_review" className="rounded-2xl border border-zinc-200 p-4 hover:border-blue-300 dark:border-zinc-800 dark:hover:border-blue-700"><span className="font-semibold">Uncategorized spending</span><span className="float-right text-zinc-500">{formatMoney(summary.transactions.transactionsToClassifyAmount)}</span></Link>
          </div>
        </div>
      </section>
    </>
  );
}
