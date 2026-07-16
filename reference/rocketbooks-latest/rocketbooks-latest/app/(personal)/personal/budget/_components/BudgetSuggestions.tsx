'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { fmtCurrency } from '@/lib/personal/format';
import type { BudgetSuggestion, Lookback } from '@/lib/personal/budget-suggest';
import type { BudgetReview } from '@/lib/personal/budget-review';
import { fetchSuggestionsAction, applySuggestionsAction, reviewSuggestionsAction } from '../_actions/suggest';

const LOOKBACKS: { value: Lookback; label: string }[] = [
  { value: 3, label: '3 mo' },
  { value: 6, label: '6 mo' },
  { value: 12, label: '12 mo' },
];

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-6 items-end gap-px" aria-hidden="true">
      {data.map((v, i) => (
        <div key={i} className="w-1 rounded-sm bg-zinc-300 dark:bg-zinc-600" style={{ height: `${Math.max(1, (v / max) * 24)}px` }} />
      ))}
    </div>
  );
}

const CONF: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  low: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

// Per-lookback cache of the last AI review so reopening the panel doesn't
// re-call the LLM. Client-only (localStorage) — the durable copy lives on the
// budget rows after Apply.
const REVIEW_CACHE_KEY = 'rs_personal_budget_reviews_v1';
function readReviewCache(): Record<number, { reviews: BudgetReview[]; summary: string }> {
  try { return JSON.parse(localStorage.getItem(REVIEW_CACHE_KEY) || '{}'); } catch { return {}; }
}
function writeReviewCache(lb: number, data: { reviews: BudgetReview[]; summary: string }) {
  try { const c = readReviewCache(); c[lb] = data; localStorage.setItem(REVIEW_CACHE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

const VERDICT: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300', label: 'AI: looks right' },
  high: { cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300', label: 'AI: likely high' },
  low: { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300', label: 'AI: may be short' },
  uncertain: { cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', label: 'AI: uncertain' },
};

export function BudgetSuggestions() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lookback, setLookback] = useState<Lookback>(6);
  const [rows, setRows] = useState<BudgetSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Map<string, number>>(new Map());
  const [loading, startLoad] = useTransition();
  const [applying, startApply] = useTransition();
  const [reviewing, startReview] = useTransition();
  const [reviews, setReviews] = useState<Map<string, BudgetReview>>(new Map());
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = (lb: Lookback) => {
    startLoad(async () => {
      const data = await fetchSuggestionsAction(lb);
      setRows(data);
      // Default-select categories that don't already have a budget.
      setSelected(new Set(data.filter((r) => !r.hasExistingBudget).map((r) => r.category)));
      setAmounts(new Map(data.map((r) => [r.category, r.suggested])));
      // Restore a cached AI review for this lookback, if any.
      const cached = readReviewCache()[lb];
      if (cached) { setReviews(new Map(cached.reviews.map((r) => [r.category, r]))); setAiSummary(cached.summary); }
      else { setReviews(new Map()); setAiSummary(null); }
    });
  };

  const review = () => {
    startReview(async () => {
      try {
        const res = await reviewSuggestionsAction(lookback);
        setReviews(new Map(res.reviews.map((r) => [r.category, r])));
        setAiSummary(res.summary || 'Review complete.');
        writeReviewCache(lookback, { reviews: res.reviews, summary: res.summary || 'Review complete.' });
      } catch {
        setAiSummary('AI review failed — please try again.');
      }
    });
  };

  const openPanel = () => {
    setOpen(true);
    setMsg(null);
    if (!rows) load(lookback);
  };

  const changeLookback = (lb: Lookback) => { setLookback(lb); load(lb); };

  const toggle = (cat: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  const apply = () => {
    if (!rows) return;
    const items = rows.filter((r) => selected.has(r.category)).map((r) => {
      const rev = reviews.get(r.category);
      return {
        category: r.category,
        amount: amounts.get(r.category) ?? r.suggested,
        ai: rev ? { verdict: rev.verdict, probability: rev.probability, note: rev.note } : null,
      };
    });
    if (items.length === 0) return;
    startApply(async () => {
      const res = await applySuggestionsAction(items);
      setMsg(res.ok ? `Applied ${res.applied} budgets.` : (res.error ?? 'Failed'));
      router.refresh();
      load(lookback); // refresh "already budgeted" flags
    });
  };

  const selectedTotal = rows ? rows.filter((r) => selected.has(r.category)).reduce((s, r) => s + (amounts.get(r.category) ?? r.suggested), 0) : 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        className="self-start rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        ✨ Suggest budgets from my history
      </button>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Suggested budgets</h2>
        <div className="flex items-center gap-1">
          {LOOKBACKS.map((l) => (
            <button key={l.value} type="button" onClick={() => changeLookback(l.value)}
              className={`rounded px-2 py-1 text-xs ${lookback === l.value ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
              {l.label}
            </button>
          ))}
          <button
            type="button"
            onClick={review}
            disabled={reviewing || !rows}
            className="ml-1 rounded border border-violet-300 px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
          >
            {reviewing ? 'Reviewing…' : aiSummary ? '✨ Re-review' : '✨ Review with AI'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="ml-2 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">Close</button>
        </div>
      </header>

      <div className="px-4 py-2 text-xs text-zinc-500">
        Estimated from your last {lookback} months (recurring counted exactly; everyday spend averaged with trend{rows?.some((r) => r.seasonalUsed) ? ' + seasonality' : ''}). Review, adjust, and apply.
      </div>

      {aiSummary && (
        <div className="mx-4 mb-1 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-200">
          <span className="font-medium">AI review:</span> {aiSummary}
        </div>
      )}

      {loading || !rows ? (
        <div className="px-4 py-10 text-center text-sm text-zinc-500">Analyzing your history…</div>
      ) : (
        <>
          <div className="max-h-[28rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Trend</th>
                  <th className="px-3 py-2 text-right font-medium">Recurring</th>
                  <th className="px-3 py-2 text-right font-medium">Variable</th>
                  <th className="px-3 py-2 text-right font-medium">Budget</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.category} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(r.category)} onChange={() => toggle(r.category)} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.category}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${CONF[r.confidence]}`}>{r.confidence}</span>
                        {r.oneOff && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-600 dark:bg-rose-950/40 dark:text-rose-300" title="A one-time charge inflates this category's history — review the amount.">one-off?</span>}
                        {r.hasExistingBudget && <span className="text-[10px] text-zinc-400">budgeted</span>}
                      </div>
                      <div className="text-[10px] text-zinc-400">{r.group} · {r.monthsOfData} mo of data</div>
                      {(() => {
                        const rev = reviews.get(r.category);
                        return rev ? (
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
                            <span className={`rounded px-1.5 py-0.5 ${VERDICT[rev.verdict].cls}`}>{VERDICT[rev.verdict].label} · {rev.probability}%</span>
                            <span className="text-zinc-400">{rev.note}</span>
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-3 py-2"><Sparkline data={r.history} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{r.recurring > 0 ? fmtCurrency(r.recurring) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{r.variable > 0 ? fmtCurrency(r.variable) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-0.5">
                        <span className="text-xs text-zinc-400">$</span>
                        <input
                          type="number" min="0" step="1"
                          value={amounts.get(r.category) ?? r.suggested}
                          onChange={(e) => setAmounts((prev) => new Map(prev).set(r.category, Number(e.target.value)))}
                          className="w-20 rounded border border-zinc-300 bg-white px-1.5 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </div>
                      {(() => {
                        const rev = reviews.get(r.category);
                        const cur = amounts.get(r.category) ?? r.suggested;
                        return rev?.adjustedAmount != null && rev.adjustedAmount !== cur ? (
                          <button
                            type="button"
                            onClick={() => setAmounts((prev) => new Map(prev).set(r.category, rev.adjustedAmount!))}
                            className="mt-1 block w-full text-right text-[10px] text-violet-600 hover:underline dark:text-violet-400"
                          >
                            use AI ${rev.adjustedAmount}
                          </button>
                        ) : null;
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="text-sm text-zinc-500">
              {selected.size} selected · <span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(selectedTotal)}</span>/mo
              {msg && <span className="ml-3 text-emerald-600 dark:text-emerald-400">{msg}</span>}
            </div>
            <button
              type="button"
              onClick={apply}
              disabled={applying || selected.size === 0}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {applying ? 'Applying…' : `Apply ${selected.size} budget${selected.size === 1 ? '' : 's'}`}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
