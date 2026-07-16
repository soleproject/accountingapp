'use client';

import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import type { DailyRow } from '../_data/loader';
import { fmtCompact, fmtCurrency, fmtDay } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  windowDays: number;
  daily: DailyRow[];
}

export function ProfitLossCard({ daily, windowDays }: Props) {
  // Per-day net P&L plus running cumulative — the cumulative line is what
  // tells the "are we above or below water" story; the bars show daily volatility.
  const data: Array<{ date: string; net: number; cumulative: number }> = [];
  let running = 0;
  for (const d of daily) {
    const net = d.revenue - d.expenses;
    running += net;
    data.push({ date: d.date, net, cumulative: running });
  }

  const totalNet = data.length ? data[data.length - 1].cumulative : 0;
  const positiveDays = data.filter((d) => d.net > 0).length;
  const negativeDays = data.filter((d) => d.net < 0).length;

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Profit &amp; loss</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Net {fmtCurrency(totalNet)} · {positiveDays} green / {negativeDays} red days · last {windowDays}d
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Daily net
          </span>
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-0.5 w-3 bg-violet-500" /> Cumulative
          </span>
          <ExplainButton
            prompt={`Walk me through the profit & loss chart on the Pulse page. Cumulative net for the last ${windowDays} days is ${fmtCurrency(totalNet)} (${positiveDays} positive days, ${negativeDays} negative days). Help me read the bars and the cumulative line — what's the trend?`}
          />
        </div>
      </header>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-zinc-800" />
            <XAxis dataKey="date" stroke="#71717a" fontSize={10} tickFormatter={fmtDay} minTickGap={28} />
            <YAxis stroke="#71717a" fontSize={10} tickFormatter={fmtCompact} width={52} />
            <Tooltip
              labelFormatter={(v) => fmtDay(String(v))}
              formatter={(v, name) => [
                fmtCurrency(typeof v === 'number' ? v : Number(v)),
                String(name) === 'net' ? 'Daily net' : 'Cumulative',
              ]}
              contentStyle={{ fontSize: 12 }}
            />
            <ReferenceLine y={0} stroke="#71717a" strokeWidth={1} />
            <Bar dataKey="net" isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.net >= 0 ? '#10b981' : '#f43f5e'} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="cumulative" stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
