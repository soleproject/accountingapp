'use client';

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { MonthlyCashflow } from '@/lib/dashboard/daily-cashflow';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function fmtAxis(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

interface Row {
  date: string;
  label: string;
  in: number;
  out: number; // stored negative so outflow draws below zero
  cumulative: number;
}

function CashTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Row }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="font-medium text-zinc-700 dark:text-zinc-200">{r.date}</div>
      <div className="text-emerald-600 dark:text-emerald-400">In {fmt(r.in)}</div>
      <div className="text-rose-600 dark:text-rose-400">Out {fmt(Math.abs(r.out))}</div>
      <div className="text-violet-600 dark:text-violet-400">Cumulative {fmt(r.cumulative)}</div>
    </div>
  );
}

export function DailyCashflowChart({ data }: { data: MonthlyCashflow }) {
  const rows: Row[] = data.points.map((p) => ({
    date: p.date,
    label: String(Number(p.date.slice(8, 10))), // day-of-month
    in: p.cashIn,
    out: -p.cashOut,
    cumulative: p.cumulative,
  }));

  const hasActivity = data.totalIn !== 0 || data.totalOut !== 0;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Cash in &amp; out · {data.monthLabel}</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Net {fmt(data.net)} · {fmt(data.totalIn)} in / {fmt(data.totalOut)} out
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Money in
          </span>
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-sm bg-rose-500" /> Money out
          </span>
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-0.5 w-3 bg-violet-500" /> Cumulative
          </span>
        </div>
      </header>

      {hasActivity ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" className="dark:opacity-20" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} tickFormatter={fmtAxis} width={48} />
              <Tooltip content={<CashTooltip />} cursor={{ fill: 'rgba(161,161,170,0.12)' }} />
              <ReferenceLine y={0} stroke="#71717a" strokeWidth={1} />
              <Bar dataKey="in" name="Money in" fill="#10b981" radius={[2, 2, 0, 0]} maxBarSize={18} />
              <Bar dataKey="out" name="Money out" fill="#f43f5e" radius={[0, 0, 2, 2]} maxBarSize={18} />
              <Line type="monotone" dataKey="cumulative" name="Cumulative" stroke="#8b5cf6" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          No cash movement recorded yet this month.
        </div>
      )}
    </div>
  );
}
