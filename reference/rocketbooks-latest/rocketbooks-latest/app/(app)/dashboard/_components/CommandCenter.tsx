'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { ActionCard } from '@/lib/server/action-cards';
import { AttentionCards } from '../../tasks/_components/AttentionCards';
import { InsightCard } from './InsightCard';
import type { CashPoint } from './CashForecastChart';
import type { MonthlyCashflow } from '@/lib/dashboard/daily-cashflow';
import type { PeriodMetrics } from '@/lib/dashboard/period-metrics';
import type { Posture, PillKey } from '@/lib/dashboard/posture';

const ChartLoading = () => <div className="flex h-56 items-center justify-center text-sm text-zinc-500">Loading chart…</div>;
const CashForecastChart = dynamic(() => import('./CashForecastChart').then((m) => m.CashForecastChart), { ssr: false, loading: ChartLoading });
const DailyCashflowChart = dynamic(() => import('./DailyCashflowChart').then((m) => m.DailyCashflowChart), { ssr: false, loading: ChartLoading });
const AskFinance = dynamic(() => import('./AskFinance').then((m) => m.AskFinance), { ssr: false, loading: ChartLoading });
const CustomPeriodPanel = dynamic(() => import('./CustomPeriodPanel').then((m) => m.CustomPeriodPanel), { ssr: false, loading: ChartLoading });

const PILL_KEYS: PillKey[] = ['needs', 'cash', 'month', 'ask'];
const PIN_STORAGE_KEY = 'rs_dash_pinned_pill';

// 'custom' is a UI-only tab (not part of the AI-driven PillKey posture set).
type Tab = PillKey | 'custom';

export interface CommandCenterProps {
  posture: Posture;
  headline: string;
  /** AI-phrased headline (cached, posture-matched) — preferred over the templated one. */
  aiHeadline?: string | null;
  defaultPill: PillKey;
  cards: ActionCard[];
  cash: { cashPosition: number; runwayLabel: string; netPerMonth: number; overdueAr: number; overdueAp: number; forecast: CashPoint[]; cashKnown: boolean };
  month: { label: string; rev: number; exp: number; net: number; prevRev: number; prevExp: number; prevNet: number };
  cashflow: MonthlyCashflow;
  custom: PeriodMetrics;
  insight: { summary: string | null; at: string | null };
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const POSTURE_STYLE: Record<Posture, { box: string; chip: string; label: string }> = {
  urgent: { box: 'border-red-300 bg-red-50/50 dark:border-red-900/60 dark:bg-red-950/20', chip: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200', label: 'Needs attention' },
  watch: { box: 'border-amber-300 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20', chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200', label: 'Keep an eye out' },
  healthy: { box: 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-900/60 dark:bg-emerald-950/20', chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200', label: 'On track' },
};

function Delta({ cur, prev, goodWhenUp }: { cur: number; prev: number; goodWhenUp: boolean }) {
  if (prev === 0) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  const good = up === goodWhenUp;
  const cls = Math.abs(pct) < 0.5 ? 'text-zinc-400' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return <span className={`text-[11px] font-medium ${cls}`}> {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%</span>;
}

function Tile({ label, value, tone, children }: { label: string; value: string; tone?: 'red' | 'emerald'; children?: React.ReactNode }) {
  const v = tone === 'red' ? 'text-red-700 dark:text-red-400' : tone === 'emerald' ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-900 dark:text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${v}`}>{value}{children}</div>
    </div>
  );
}

export function CommandCenter(props: CommandCenterProps) {
  const { posture, headline, aiHeadline, defaultPill, cards, cash, month, cashflow, custom, insight } = props;
  const [pill, setPill] = useState<Tab>(defaultPill);
  const [pinned, setPinned] = useState<PillKey | null>(null);
  const style = POSTURE_STYLE[posture];

  // Honor the user's pinned tab — except when posture is 'urgent', where the AI
  // override wins so a cash emergency always surfaces. Pin lives in localStorage.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let p: PillKey | null = null;
    try {
      const v = localStorage.getItem(PIN_STORAGE_KEY);
      if (v && (PILL_KEYS as string[]).includes(v)) p = v as PillKey;
    } catch {
      /* ignore */
    }
    setPinned(p);
    if (p && posture !== 'urgent') setPill(p);
  }, [posture]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const togglePin = () => {
    if (pill === 'custom') return; // custom is not a pinnable AI tab
    const next = pinned === pill ? null : pill;
    setPinned(next);
    try {
      if (next) localStorage.setItem(PIN_STORAGE_KEY, next);
      else localStorage.removeItem(PIN_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const pills: { key: Tab; label: string; badge?: number }[] = [
    { key: 'needs', label: 'Needs you', badge: cards.length || undefined },
    { key: 'cash', label: 'Cash' },
    { key: 'month', label: 'This month' },
    { key: 'custom', label: 'Custom' },
    { key: 'ask', label: 'Ask' },
  ];

  return (
    <section className={`rounded-xl border p-4 ${style.box}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-lg leading-none">✦</span>
          <p className="max-w-3xl text-sm font-medium text-zinc-800 dark:text-zinc-100">{aiHeadline || headline}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${style.chip}`}>{style.label}</span>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {pills.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPill(p.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              pill === p.key
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {p.label}
            {p.badge ? <span className="ml-1 opacity-70">{p.badge}</span> : null}
          </button>
        ))}
        {pill !== 'custom' && (
          <button
            type="button"
            onClick={togglePin}
            title={pinned === pill ? 'Unpin — go back to the AI-suggested view' : 'Pin this as your default view'}
            className={`ml-1 rounded-full px-2 py-1 text-xs transition-colors ${
              pinned === pill ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'
            }`}
          >
            {pinned === pill ? '📌 Pinned' : '📌 Pin'}
          </button>
        )}
      </div>

      <div className="mt-4">
        {pill === 'needs' && (
          cards.length > 0 ? (
            <AttentionCards cards={cards} source="dashboard" />
          ) : (
            <p className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm italic text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              ✓ You&apos;re all caught up — nothing needs your attention right now.
            </p>
          )
        )}

        {pill === 'cash' && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile label="Cash on hand" value={cash.cashKnown ? fmt(cash.cashPosition) : '—'} tone={cash.cashKnown && cash.cashPosition < 0 ? 'red' : undefined} />
              <Tile label="Runway" value={cash.cashKnown ? cash.runwayLabel : cash.netPerMonth >= 0 ? 'Profitable' : '—'} />
              <Tile label="Net / month" value={fmt(cash.netPerMonth)} tone={cash.netPerMonth >= 0 ? 'emerald' : 'red'} />
            </div>
            {!cash.cashKnown && (
              <Link prefetch={false} href="/integrations/plaid" className="rounded-md border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30">
                Connect a bank to track cash &amp; runway →
              </Link>
            )}
            {(cash.overdueAr > 0 || cash.overdueAp > 0) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {cash.overdueAr > 0 && (
                  <Link prefetch={false} href="/invoices" className="rounded-md border border-emerald-300 px-2.5 py-1 font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                    Chase {fmt(cash.overdueAr)} overdue invoices →
                  </Link>
                )}
                {cash.overdueAp > 0 && (
                  <Link prefetch={false} href="/bills" className="rounded-md border border-amber-300 px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30">
                    {fmt(cash.overdueAp)} in bills overdue →
                  </Link>
                )}
              </div>
            )}
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <header className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Projected cash · next 6 months</h3>
                <span className="text-xs text-zinc-400">base · shaded = best/worst</span>
              </header>
              <CashForecastChart data={cash.forecast} />
            </div>
          </div>
        )}

        {pill === 'month' && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile label={`Revenue · ${month.label}`} value={fmt(month.rev)} tone="emerald"><Delta cur={month.rev} prev={month.prevRev} goodWhenUp /></Tile>
              <Tile label={`Expenses · ${month.label}`} value={fmt(month.exp)}><Delta cur={month.exp} prev={month.prevExp} goodWhenUp={false} /></Tile>
              <Tile label={`Net · ${month.label}`} value={fmt(month.net)} tone={month.net >= 0 ? 'emerald' : 'red'}><Delta cur={month.net} prev={month.prevNet} goodWhenUp /></Tile>
            </div>
            <DailyCashflowChart data={cashflow} />
            <InsightCard initialSummary={insight.summary} initialAt={insight.at} posture={posture} />
          </div>
        )}

        {pill === 'custom' && <CustomPeriodPanel initial={custom} />}

        {pill === 'ask' && <AskFinance />}
      </div>
    </section>
  );
}
