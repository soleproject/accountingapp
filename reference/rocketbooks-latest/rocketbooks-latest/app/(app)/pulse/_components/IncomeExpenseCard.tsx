'use client';

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import type { DailyRow } from '../_data/loader';
import { fmtCompact, fmtCurrency, fmtDay } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  windowDays: number;
  daily: DailyRow[];
}

export function IncomeExpenseCard({ daily, windowDays }: Props) {
  const totalRevenue = daily.reduce((s, d) => s + d.revenue, 0);
  const totalExpenses = daily.reduce((s, d) => s + d.expenses, 0);

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Income vs. expenses</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {fmtCurrency(totalRevenue)} in · {fmtCurrency(totalExpenses)} out · last {windowDays}d
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> Income
          </span>
          <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-rose-500" /> Expenses
          </span>
          <ExplainButton
            prompt={`Walk me through the income vs. expenses chart on the Pulse page. Last ${windowDays} days: ${fmtCurrency(totalRevenue)} in, ${fmtCurrency(totalExpenses)} out. Help me read the daily pattern and call out any spikes, gaps, or trends.`}
          />
        </div>
      </header>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="ie-rev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="ie-exp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-zinc-800" />
            <XAxis dataKey="date" stroke="#71717a" fontSize={10} tickFormatter={fmtDay} minTickGap={28} />
            <YAxis stroke="#71717a" fontSize={10} tickFormatter={fmtCompact} width={52} />
            <Tooltip
              labelFormatter={(v) => fmtDay(String(v))}
              formatter={(v, name) => [
                fmtCurrency(typeof v === 'number' ? v : Number(v)),
                String(name) === 'revenue' ? 'Income' : 'Expenses',
              ]}
              contentStyle={{ fontSize: 12 }}
            />
            <Area type="monotone" dataKey="revenue" stroke="#10b981" fill="url(#ie-rev)" strokeWidth={2} isAnimationActive={false} />
            <Area type="monotone" dataKey="expenses" stroke="#f43f5e" fill="url(#ie-exp)" strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
