'use client';

import { useState, useTransition } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { askFinanceAction } from '../_actions/ask';
import type { FinanceAnswer } from '@/lib/server/finance-query';

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

const EXAMPLES = ['Who owes me money?', 'This month vs last month', 'Biggest expense changes', 'How much on rent this year?', 'Top 5 expense categories'];

export function AskFinance() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<FinanceAnswer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ask = (question: string) => {
    if (!question.trim()) return;
    setErr(null);
    start(async () => {
      const r = await askFinanceAction(question);
      if (r.ok && r.answer) {
        setRes(r.answer);
      } else {
        setRes(null);
        setErr(r.error ?? 'Could not answer that.');
      }
    });
  };

  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/30 p-4 dark:border-blue-900/60 dark:bg-blue-950/20">
      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about your finances — e.g. “revenue by month this year”"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => { setQ(x); ask(x); }}
            disabled={pending}
            className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-[11px] text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:bg-zinc-900 dark:text-blue-300"
          >
            {x}
          </button>
        ))}
      </div>

      {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>}
      {res && <Result a={res} />}
    </section>
  );
}

function Result({ a }: { a: FinanceAnswer }) {
  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">{a.title}</h3>
      {a.chart === 'number' ? (
        <div className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{usd(a.data[0]?.value ?? 0)}</div>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {a.chart === 'line' ? (
              <LineChart data={a.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} tickFormatter={compact} />
                <Tooltip formatter={(v) => usd(Number(v))} contentStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            ) : (
              <BarChart data={a.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" stroke="#71717a" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
                <YAxis stroke="#71717a" fontSize={11} tickFormatter={compact} />
                <Tooltip formatter={(v) => usd(Number(v))} contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="value" fill="#2563eb" radius={[3, 3, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
