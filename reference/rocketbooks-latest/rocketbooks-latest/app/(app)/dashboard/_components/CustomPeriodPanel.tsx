'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { TrendChart } from './TrendChart';
import { loadCustomPeriodAction } from '../_actions/customPeriod';
import type { PeriodMetrics } from '@/lib/dashboard/period-metrics';

const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const w = 120, h = 28, pad = 2;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-7 w-full" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function DeltaBadge({ pct, goodWhenUp }: { pct: number; goodWhenUp: boolean }) {
  const up = pct >= 0;
  const good = up === goodWhenUp;
  const cls = Math.abs(pct) < 0.5 ? 'text-zinc-400' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <span title="2nd half vs 1st half of range" className={`shrink-0 text-[11px] font-medium ${cls}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Kpi({
  label,
  value,
  tone,
  href,
  series,
  sparkColor,
  delta,
}: {
  label: string;
  value: string;
  tone?: 'emerald' | 'amber' | 'red';
  href?: string;
  series?: number[];
  sparkColor?: string;
  delta?: { pct: number | null; goodWhenUp: boolean };
}) {
  const palette =
    tone === 'emerald'
      ? 'border-emerald-200 dark:border-emerald-900'
      : tone === 'amber'
        ? 'border-amber-200 dark:border-amber-900'
        : tone === 'red'
          ? 'border-red-200 dark:border-red-900'
          : 'border-zinc-200 dark:border-zinc-800';
  const base = `rounded-lg border bg-white p-4 dark:bg-zinc-950 ${palette}`;
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
        {delta && delta.pct != null && <DeltaBadge pct={delta.pct} goodWhenUp={delta.goodWhenUp} />}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {series && series.length > 1 && <Sparkline data={series} color={sparkColor ?? '#71717a'} />}
    </>
  );
  if (href) {
    return (
      <Link prefetch={false} href={href} className={`${base} block transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:hover:border-zinc-700 dark:hover:bg-zinc-900`}>
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

export function CustomPeriodPanel({ initial }: { initial: PeriodMetrics }) {
  const [data, setData] = useState<PeriodMetrics>(initial);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = () => {
    setErr(null);
    startTransition(async () => {
      const r = await loadCustomPeriodAction(from, to);
      if (r.ok) setData(r.data);
      else setErr(r.error);
    });
  };

  const net = data.totalRevenue - data.totalExpenses;
  const rangeLabel = `${data.from} → ${data.to}`;

  return (
    <div className="flex flex-col gap-3">
      {/* Date range controls */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <button
          type="button"
          onClick={apply}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? 'Loading…' : 'Apply'}
        </button>
        {err && <span className="text-xs text-red-600 dark:text-red-400">{err}</span>}
      </div>

      <div className={`flex flex-col gap-3 transition-opacity ${pending ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi label="Revenue" value={fmt(data.totalRevenue)} tone="emerald" href="/reports" series={data.revSeries} sparkColor="#10b981" delta={{ pct: data.revDelta, goodWhenUp: true }} />
          <Kpi label="Expenses" value={fmt(data.totalExpenses)} tone="amber" href="/reports" series={data.expSeries} sparkColor="#f59e0b" delta={{ pct: data.expDelta, goodWhenUp: false }} />
          <Kpi label="Net" value={fmt(net)} tone={net >= 0 ? 'emerald' : 'red'} href="/reports" series={data.nets} sparkColor={net >= 0 ? '#10b981' : '#ef4444'} delta={{ pct: data.netDelta, goodWhenUp: true }} />
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <header className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Revenue vs. Expenses · {rangeLabel}</h3>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Revenue</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> Expenses</span>
            </div>
          </header>
          {data.trend.length > 0 ? (
            <TrendChart data={data.trend} />
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">No activity in this range.</div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi label="Transactions" value={data.txnCount.toLocaleString()} href="/transactions" />
          <Kpi label="Contacts" value={data.contactCount.toLocaleString()} href="/contacts" />
          <Kpi label="Accounts (COA)" value={data.accountCount.toLocaleString()} href="/chart-of-accounts" />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Recent transactions</h3>
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">No transactions in this range.</td>
                  </tr>
                )}
                {data.recent.map((t) => (
                  <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{t.date}</td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.bankDescription ?? t.description ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{t.amount != null ? fmt(t.amount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
