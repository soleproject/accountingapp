'use client';

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { CashSeriesRow } from '../_data/loader';
import { fmtCompact, fmtCurrency, fmtDay } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  windowDays: number;
  cashSeries: CashSeriesRow[];
  cashNow: number;
  projectedCash: number;
  withExtrapolation: boolean;
  today: string;
}

export function CashFlowCard({ windowDays, cashSeries, cashNow, projectedCash, withExtrapolation, today }: Props) {
  const delta = projectedCash - cashNow;
  const trend = delta >= 0 ? 'gaining' : 'burning';
  const prompt = withExtrapolation
    ? `Walk me through the cash-flow chart on the Pulse page. The window is ${windowDays} days back and ${windowDays} days forward. Cash on hand is ${fmtCurrency(cashNow)}; projected cash at the end of the forward window is ${fmtCurrency(projectedCash)} (${fmtCurrency(delta)} change). The "Forecast overlay" toggle is on, so the dotted line combines scheduled invoices/bills with a moving-average baseline. Help me read what each line means and what the projection implies.`
    : `Walk me through the cash-flow chart on the Pulse page. The window is ${windowDays} days back and ${windowDays} days forward. Cash on hand is ${fmtCurrency(cashNow)}; based on scheduled invoices and bills, projected cash at the end of the forward window is ${fmtCurrency(projectedCash)}. The forward line is "scheduled-only" — what's already booked, no extrapolation. Help me read it and call out anything noteworthy.`;

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Cash position · {windowDays}d back · {windowDays}d forward
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {fmtCurrency(cashNow)} today · projected {fmtCurrency(projectedCash)} ({trend} {fmtCurrency(Math.abs(delta))})
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-emerald-500" /> Actual
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 border-t border-dashed border-amber-500" /> Scheduled
          </span>
          {withExtrapolation && (
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 border-t border-dotted border-violet-500" /> Forecast
            </span>
          )}
          <ExplainButton prompt={prompt} />
        </div>
      </header>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={cashSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-zinc-800" />
            <XAxis
              dataKey="date"
              stroke="#71717a"
              fontSize={10}
              tickFormatter={fmtDay}
              minTickGap={28}
            />
            <YAxis stroke="#71717a" fontSize={10} tickFormatter={fmtCompact} width={56} />
            <Tooltip
              labelFormatter={(v) => fmtDay(String(v))}
              formatter={(v, name) => {
                const n = typeof v === 'number' ? v : Number(v);
                if (!Number.isFinite(n)) return ['—', String(name)];
                return [fmtCurrency(n), formatLineName(String(name))];
              }}
              contentStyle={{ fontSize: 12 }}
            />
            <ReferenceLine
              x={today}
              stroke="#71717a"
              strokeDasharray="4 4"
              label={{ value: 'today', position: 'top', fontSize: 10, fill: '#71717a' }}
            />
            <Area
              type="monotone"
              dataKey="actual"
              stroke="#10b981"
              fill="url(#cashFill)"
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="scheduled"
              stroke="#f59e0b"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            {withExtrapolation && (
              <Line
                type="monotone"
                dataKey="extrapolated"
                stroke="#8b5cf6"
                strokeWidth={2}
                strokeDasharray="2 3"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function formatLineName(key: string): string {
  if (key === 'actual') return 'Actual';
  if (key === 'scheduled') return 'Scheduled';
  if (key === 'extrapolated') return 'Forecast';
  return key;
}
