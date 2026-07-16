'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { VALID_WINDOWS } from '../_data/window';

interface Props {
  windowDays: number;
  withExtrapolation: boolean;
  orgName: string;
}

export function PulseHeader({ windowDays, withExtrapolation, orgName }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const { seedPrompt } = useAssistant();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  }

  function walkThrough() {
    // Phrasing follows the project rule that AI suggestion-chip verbs must be
    // backed by real capability — "walk me through" is narration of what the
    // page already shows, not an action that pretends to do something else.
    seedPrompt(
      `Walk me through what's on this Pulse page for ${orgName}. The window is the last and next ${windowDays} days. Briefly cover: cash flow now and where it's headed, income vs expenses, profit/loss, outstanding A/R and A/P aging, and the top expense categories. Use the numbers that are already in your page context — don't re-query unless something looks off.`,
    );
  }

  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Pulse</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {orgName} · last {windowDays} days back, next {windowDays} days forward
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={walkThrough}
          className="rs-rainbow-border rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:shadow-md dark:bg-zinc-950 dark:text-zinc-200"
        >
          Walk me through this page
        </button>

        <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <span className="text-zinc-500 dark:text-zinc-400">Window</span>
          <select
            value={windowDays}
            disabled={pending}
            onChange={(e) => setParam('days', e.target.value)}
            className="bg-transparent text-sm font-medium focus:outline-none"
          >
            {VALID_WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <input
            type="checkbox"
            checked={withExtrapolation}
            disabled={pending}
            onChange={(e) => setParam('ext', e.target.checked ? '1' : null)}
            className="h-3.5 w-3.5"
          />
          <span className="text-zinc-600 dark:text-zinc-400">Forecast overlay</span>
        </label>
      </div>
    </header>
  );
}
