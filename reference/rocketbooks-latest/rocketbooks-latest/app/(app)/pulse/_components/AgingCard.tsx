'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import type { AgingBuckets } from '../_data/loader';
import { fmtCompact, fmtCurrency } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  kind: 'ar' | 'ap';
  aging: AgingBuckets;
  windowDays: number;
}

const BUCKET_ORDER: Array<{ key: keyof AgingBuckets; label: string; color: string }> = [
  { key: 'current', label: 'Not yet due', color: '#10b981' },
  { key: 'days0_30', label: '1–30 overdue', color: '#f59e0b' },
  { key: 'days31_60', label: '31–60 overdue', color: '#fb923c' },
  { key: 'days60Plus', label: '60+ overdue', color: '#f43f5e' },
];

export function AgingCard({ kind, aging, windowDays }: Props) {
  const isAr = kind === 'ar';
  const title = isAr ? 'Outstanding A/R' : 'Outstanding A/P';
  const subject = isAr ? 'invoices customers owe you' : 'bills you owe vendors';
  const data = BUCKET_ORDER.map((b) => ({
    label: b.label,
    amount: aging[b.key] as number,
    color: b.color,
  })).filter((d) => d.amount > 0 || true); // keep all buckets so empty bars show

  const overdue = aging.days0_30 + aging.days31_60 + aging.days60Plus;
  const overduePct = aging.total > 0 ? Math.round((overdue / aging.total) * 100) : 0;

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {fmtCurrency(aging.total)} total · {fmtCurrency(overdue)} overdue ({overduePct}%)
          </p>
        </div>
        <ExplainButton
          prompt={`Walk me through the ${title} aging chart on the Pulse page (${subject}). Total ${fmtCurrency(aging.total)}; not-yet-due ${fmtCurrency(aging.current)}, 1–30 overdue ${fmtCurrency(aging.days0_30)}, 31–60 overdue ${fmtCurrency(aging.days31_60)}, 60+ overdue ${fmtCurrency(aging.days60Plus)}. Window is ${windowDays} days. Help me read it and call out anything I should act on.`}
        />
      </header>
      {aging.total === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
          Nothing outstanding right now.
        </div>
      ) : (
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-zinc-800" />
              <XAxis dataKey="label" stroke="#71717a" fontSize={10} />
              <YAxis stroke="#71717a" fontSize={10} tickFormatter={fmtCompact} width={52} />
              <Tooltip
                formatter={(v) => [fmtCurrency(typeof v === 'number' ? v : Number(v)), 'Amount']}
                contentStyle={{ fontSize: 12 }}
              />
              <Bar dataKey="amount" isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
