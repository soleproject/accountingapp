'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { fmtCurrency } from '@/lib/personal/format';
import { createBudgetAction, updateBudgetAction, deleteBudgetAction } from '../_actions/budgets';

interface Budget {
  id: string;
  category: string;
  monthlyLimit: number;
  rollover: boolean;
  spentThisMonth: number;
  rolloverBalance: number;
  available: number;
  aiVerdict: string | null;
  aiProbability: number | null;
  aiNote: string | null;
}

const AI_VERDICT: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'text-emerald-600 dark:text-emerald-400', label: 'looks right' },
  high: { cls: 'text-rose-600 dark:text-rose-400', label: 'likely high' },
  low: { cls: 'text-amber-600 dark:text-amber-400', label: 'may be short' },
  uncertain: { cls: 'text-zinc-500', label: 'uncertain' },
};

export function BudgetManager({ budgets, addableCategories }: { budgets: Budget[]; addableCategories: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [newCat, setNewCat] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newRollover, setNewRollover] = useState(false);

  const run = (fn: () => Promise<unknown>) => startTransition(async () => { await fn(); router.refresh(); });

  const add = () => {
    const limit = Number(newLimit);
    if (!newCat || !Number.isFinite(limit) || limit < 0) return;
    run(async () => {
      await createBudgetAction({ category: newCat, monthlyLimit: limit, rollover: newRollover });
      setNewCat(''); setNewLimit(''); setNewRollover(false);
    });
  };

  const commitLimit = (id: string, value: string, prev: number) => {
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit < 0 || limit === prev) return;
    run(() => updateBudgetAction({ id, monthlyLimit: limit }));
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Add budget */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Add budget</h2>
        {addableCategories.length === 0 ? (
          <p className="text-sm text-zinc-500">Every category already has a budget. Edit limits below.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">Choose category…</option>
              {addableCategories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="flex items-center gap-1">
              <span className="text-sm text-zinc-500">$</span>
              <input
                type="number"
                min="0"
                step="1"
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                placeholder="Monthly limit"
                className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={newRollover} onChange={(e) => setNewRollover(e.target.checked)} /> Rollover
            </label>
            <button
              type="button"
              onClick={add}
              disabled={pending || !newCat || !newLimit}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Add
            </button>
          </div>
        )}
      </section>

      {/* Budgets */}
      {budgets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
          No budgets yet. Add one above to start tracking a category against a monthly limit.
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          {budgets.map((b) => {
            const over = b.spentThisMonth > b.available;
            const pct = b.available > 0 ? Math.min(100, Math.round((b.spentThisMonth / b.available) * 100)) : (b.spentThisMonth > 0 ? 100 : 0);
            const remaining = b.available - b.spentThisMonth;
            return (
              <div key={b.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{b.category}</span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1 text-sm">
                      <span className="text-zinc-500">$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={b.monthlyLimit}
                        disabled={pending}
                        onBlur={(e) => commitLimit(b.id, e.target.value, b.monthlyLimit)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className="w-24 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                      />
                      <span className="text-xs text-zinc-400">/mo</span>
                    </div>
                    <label className="flex items-center gap-1 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={b.rollover}
                        disabled={pending}
                        onChange={(e) => run(() => updateBudgetAction({ id: b.id, rollover: e.target.checked }))}
                      />
                      rollover
                    </label>
                    <button
                      type="button"
                      onClick={() => run(() => deleteBudgetAction({ id: b.id }))}
                      disabled={pending}
                      className="rounded px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-950/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={`h-full rounded-full ${over ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-500">
                    {fmtCurrency(b.spentThisMonth)} spent
                    {b.rollover && b.rolloverBalance > 0 && (
                      <span className="text-zinc-400"> · {fmtCurrency(b.monthlyLimit)} + {fmtCurrency(b.rolloverBalance)} rolled over</span>
                    )}
                  </span>
                  <span className={over ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500'}>
                    {over ? `${fmtCurrency(-remaining)} over` : `${fmtCurrency(remaining)} left`}
                  </span>
                </div>
                {b.aiVerdict && (
                  <div className="mt-1 text-[11px] text-zinc-400">
                    <span className="font-medium text-violet-600 dark:text-violet-400">AI</span>
                    {' · '}
                    <span className={AI_VERDICT[b.aiVerdict]?.cls ?? 'text-zinc-500'}>{AI_VERDICT[b.aiVerdict]?.label ?? b.aiVerdict}</span>
                    {b.aiProbability != null && <span> · {b.aiProbability}% likely to hold</span>}
                    {b.aiNote && <span> — {b.aiNote}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
