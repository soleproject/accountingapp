'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { autoMatchReconciliationAction, type AutoMatchResult } from '../_actions/reconcile';

function summarize(r: AutoMatchResult): { text: string; tone: 'good' | 'mixed' | 'bad' } {
  if (!r.ok) return { text: r.error ?? 'Auto-match failed.', tone: 'bad' };
  const more = r.more > 0 ? ` (+${r.more} more — click again)` : '';
  if (r.ran === 0) return { text: 'Nothing to auto-match — open the workspace.', tone: 'bad' };
  if (r.stillOpen === 0) return { text: `All tied out ✓${more}`, tone: 'good' };
  if (r.tiedOut === 0) return { text: `Couldn't tie out — open the workspace.${more}`, tone: 'bad' };
  return { text: `Tied out ${r.tiedOut} of ${r.ran} — ${r.stillOpen} still need review${more}`, tone: 'mixed' };
}

export function AutoMatchButton({ orgId, demo }: { orgId: string; demo: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: 'good' | 'mixed' | 'bad' } | null>(null);

  async function run() {
    if (busy || demo) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await autoMatchReconciliationAction(orgId);
      setResult(summarize(r));
      if (r.ok && r.tiedOut > 0) router.refresh();
    } catch {
      setResult({ text: 'Auto-match failed — try again.', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  const toneCls =
    result?.tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : result?.tone === 'mixed'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-zinc-500 dark:text-zinc-400';

  return (
    <span className="inline-flex items-center gap-2">
      {result && <span className={`text-xs ${toneCls}`}>{result.text}</span>}
      <button
        type="button"
        onClick={run}
        disabled={busy || demo}
        title={demo ? 'Demo data — disabled' : 'Re-run AI auto-reconciliation for this client'}
        className="inline-flex items-center gap-1 rounded-md border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
      >
        {busy && (
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-600"
          />
        )}
        {busy ? 'Matching…' : 'Auto-match'}
      </button>
    </span>
  );
}
