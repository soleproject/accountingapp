'use client';

import { useState, useTransition } from 'react';
import { fmtCurrency } from '@/lib/personal/format';
import type { CategoryBreakdown, CategoryDetail, ReportPeriod, RangeInput, MonthlyTrendPoint } from '@/lib/personal/reports';
import { fetchBreakdownAction, fetchCategoryDetailAction } from '../_actions/reports';
import { TrendsChart } from './TrendsChart';

const PRESETS: { value: ReportPeriod; label: string }[] = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30_days', label: '30 days' },
  { value: 'this_year', label: 'This year' },
  { value: 'all', label: 'All time' },
];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function ReportsView({ initialBreakdown, trends }: { initialBreakdown: CategoryBreakdown; trends: MonthlyTrendPoint[] }) {
  const [period, setPeriod] = useState<ReportPeriod | 'custom'>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [breakdown, setBreakdown] = useState<CategoryBreakdown>(initialBreakdown);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<CategoryDetail | null>(null);
  const [pendingBreakdown, startBreakdown] = useTransition();
  const [pendingDetail, startDetail] = useTransition();

  const currentRange = (): RangeInput =>
    period === 'custom' ? { kind: 'custom', start: customStart, end: customEnd } : { kind: 'preset', period };

  const loadBreakdown = (range: RangeInput) => {
    setExpanded(null);
    setDetail(null);
    startBreakdown(async () => setBreakdown(await fetchBreakdownAction(range)));
  };

  const choosePreset = (p: ReportPeriod) => {
    setPeriod(p);
    loadBreakdown({ kind: 'preset', period: p });
  };

  const applyCustom = () => {
    if (!customStart || !customEnd) return;
    loadBreakdown({ kind: 'custom', start: customStart, end: customEnd });
  };

  const toggle = (category: string) => {
    if (expanded === category) { setExpanded(null); setDetail(null); return; }
    setExpanded(category);
    setDetail(null);
    startDetail(async () => setDetail(await fetchCategoryDetailAction({ range: currentRange(), category })));
  };

  const { total, categories } = breakdown;

  return (
    <div className="flex flex-col gap-6">
      {/* Trends */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Income vs expense · last 12 months <span className="font-normal normal-case text-zinc-400">(excludes transfers)</span>
        </h2>
        <TrendsChart points={trends} />
      </section>

      {/* Period controls */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => choosePreset(p.value)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                period === p.value ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPeriod('custom')}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              period === 'custom' ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
            }`}
          >
            Custom
          </button>
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            <span className="text-zinc-400">to</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            <button
              type="button"
              onClick={applyCustom}
              disabled={!customStart || !customEnd || pendingBreakdown}
              className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {/* Category breakdown */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">By category</h2>
          <span className="text-sm font-medium tabular-nums">{fmtCurrency(total)} total</span>
        </header>

        {pendingBreakdown ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">Loading…</div>
        ) : categories.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">No spending in this period.</div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {categories.map((c) => {
              const pct = total > 0 ? Math.round((c.spent / total) * 100) : 0;
              const isOpen = expanded === c.category;
              return (
                <li key={c.category}>
                  <button type="button" onClick={() => toggle(c.category)} className="w-full px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                        <Chevron open={isOpen} />{c.category}
                        <span className="text-xs text-zinc-400">· {c.count}</span>
                      </span>
                      <span className="tabular-nums text-zinc-500">{fmtCurrency(c.spent)} · {pct}%</span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div className="h-full rounded-full bg-pink-500" style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                      {pendingDetail || !detail ? (
                        <div className="py-4 text-center text-xs text-zinc-500">Loading transactions…</div>
                      ) : (
                        <CategoryDetailPanel detail={detail} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function CategoryTrend({ points }: { points: { month: string; spent: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.spent));
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">12-month trend</div>
      <div className="flex items-end gap-1" style={{ height: 48 }}>
        {points.map((p) => (
          <div key={p.month} className="flex flex-1 flex-col items-center justify-end" title={`${p.month}: ${fmtCurrency(p.spent)}`}>
            <div className="w-full rounded-sm bg-pink-400" style={{ height: `${Math.max(2, (p.spent / max) * 44)}px` }} />
            <span className="mt-0.5 text-[8px] text-zinc-400">{p.month.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryDetailPanel({ detail }: { detail: CategoryDetail }) {
  const maxMerchant = detail.byMerchant[0]?.spent ?? 1;
  return (
    <div className="flex flex-col gap-4">
      <CategoryTrend points={detail.monthlyTrend} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Top merchants</div>
          <ul className="flex flex-col gap-1.5">
            {detail.byMerchant.map((m) => (
              <li key={m.merchant}>
                <div className="flex items-center justify-between text-xs">
                  <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">{m.merchant}</span>
                  <span className="tabular-nums text-zinc-500">{fmtCurrency(m.spent)}</span>
                </div>
                <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-pink-400" style={{ width: `${Math.round((m.spent / maxMerchant) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            Transactions{detail.transactions.length >= 200 ? ' (latest 200)' : ''}
          </div>
          <div className="max-h-64 overflow-y-auto rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-xs">
              <tbody>
                {detail.transactions.map((t) => (
                  <tr key={t.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="px-2 py-1.5 tabular-nums text-zinc-400">{t.date.slice(5)}</td>
                    <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300">{t.merchant ?? t.description ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(t.amount)}</td>
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
