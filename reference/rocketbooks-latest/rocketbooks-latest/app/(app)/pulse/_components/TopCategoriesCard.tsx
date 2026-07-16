'use client';

import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { fmtCurrency } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  windowDays: number;
  categories: Array<{ name: string; amount: number }>;
}

const PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#14b8a6', '#a3a3a3'];

export function TopCategoriesCard({ categories, windowDays }: Props) {
  const total = categories.reduce((s, c) => s + c.amount, 0);
  const top = categories[0];

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Top expense categories</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {fmtCurrency(total)} across {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} · last {windowDays}d
          </p>
        </div>
        <ExplainButton
          prompt={`Walk me through the top expense categories on the Pulse page for the last ${windowDays} days. Total ${fmtCurrency(total)}${top ? `; biggest is ${top.name} at ${fmtCurrency(top.amount)}` : ''}. Categories: ${categories.map((c) => `${c.name} ${fmtCurrency(c.amount)}`).join('; ')}. Help me see where the money is going and flag anything that looks unusual for a business like mine.`}
        />
      </header>

      {categories.length === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-zinc-500">
          No expense activity in this window.
        </div>
      ) : (
        <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-2">
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  formatter={(v, name) => [fmtCurrency(typeof v === 'number' ? v : Number(v)), String(name)]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Pie
                  data={categories}
                  dataKey="amount"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {categories.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {categories.map((c, i) => {
              const pct = total > 0 ? Math.round((c.amount / total) * 100) : 0;
              return (
                <li key={c.name} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                    />
                    <span className="truncate text-zinc-700 dark:text-zinc-300">{c.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                    {fmtCurrency(c.amount)} <span className="text-[10px]">({pct}%)</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
