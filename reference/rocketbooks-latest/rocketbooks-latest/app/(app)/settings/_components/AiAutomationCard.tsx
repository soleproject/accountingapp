'use client';

import { useState, useTransition } from 'react';
import { setAiAutomationLevel } from '../_actions/aiAutomation';
import { AUTOMATION_LEVELS, type AutomationLevel } from '@/lib/accounting/automation-levels';

/**
 * Org-level control for how aggressively the AI posts categorizations on its
 * own. Maps to (aiAutoPostEnabled, aiAutoPostThreshold) server-side; the
 * auto-categorize job reads them on its next run. Optimistic with rollback,
 * matching MeetingFollowupsCard.
 */
export function AiAutomationCard({ level }: { level: AutomationLevel }) {
  const [value, setValue] = useState<AutomationLevel>(level);
  const [saved, setSaved] = useState<AutomationLevel>(level);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const current = AUTOMATION_LEVELS.find((l) => l.value === value) ?? AUTOMATION_LEVELS[2];

  const save = (next: AutomationLevel) => {
    setError(null);
    startTransition(async () => {
      const r = await setAiAutomationLevel(next);
      if (!r.ok) {
        setError(r.error ?? 'Save failed');
        setValue(saved);
        return;
      }
      setSaved(next);
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          AI Categorization Automation
        </h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          Controls how confident the AI must be before it posts a categorization on its own. Lower-confidence
          transactions always wait in the review queue regardless of this setting — this only changes how much
          posts automatically vs. waits for a one-click approval.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Automation level</span>
          <select
            value={value}
            onChange={(e) => {
              const next = e.target.value as AutomationLevel;
              setValue(next);
              save(next);
            }}
            disabled={isPending}
            className="max-w-md rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          >
            {AUTOMATION_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">{current.description}</span>
        </label>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        {isPending && <div className="text-xs text-zinc-500">Saving…</div>}
      </div>
    </section>
  );
}
