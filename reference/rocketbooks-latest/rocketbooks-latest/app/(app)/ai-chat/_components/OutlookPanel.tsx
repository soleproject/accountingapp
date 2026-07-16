'use client';

import { useEffect, useRef, useState } from 'react';
import type { OutlookData } from '@/lib/server/outlook';
import { OutlookTile } from './OutlookTile';

const WINDOWS = [30, 45, 60, 90] as const;
type Window = (typeof WINDOWS)[number];

function isWindow(n: number): n is Window {
  return (WINDOWS as readonly number[]).includes(n);
}

interface Props {
  initialData: OutlookData;
}

/**
 * Right rail on /ai-chat (lg: and up). Owns dropdown state and re-fetches
 * /api/outlook on dropdown change. Server-rendered initial paint via
 * `initialData`; the client takes over after the first user interaction.
 *
 * No polling — outlook numbers move on AR/AP changes and posted JEs, neither
 * of which happen mid-chat for this user. revalidatePath in server actions
 * (createInvoice, createBill, etc.) covers the hard cases.
 */
export function OutlookPanel({ initialData }: Props) {
  const [windowDays, setWindowDays] = useState<Window>(
    isWindow(initialData.windowDays) ? initialData.windowDays : 60,
  );
  const [data, setData] = useState<OutlookData>(initialData);
  const [pending, setPending] = useState(false);
  // Skip the first effect run — initialData already matches windowDays on mount.
  const skipNextFetch = useRef(true);

  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    let cancelled = false;
    setPending(true);
    (async () => {
      try {
        const r = await fetch(`/api/outlook?windowDays=${windowDays}`, { cache: 'no-store' });
        if (!r.ok) return;
        const json = (await r.json()) as OutlookData;
        if (!cancelled) setData(json);
      } catch {
        // keep stale data on transient errors
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const w = data.windowDays;

  return (
    <div className="flex flex-col gap-3" aria-busy={pending}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Outlook</h2>
        <select
          value={windowDays}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (isWindow(n)) setWindowDays(n);
          }}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          aria-label="Outlook projection window"
        >
          {WINDOWS.map((wd) => (
            <option key={wd} value={wd}>
              {wd} days
            </option>
          ))}
        </select>
      </div>

      <OutlookTile
        variant="flow"
        title="Income"
        actual={data.income.actual}
        actualLabel={`Last ${w} days`}
        projected={data.income.projected}
        projectedLabel={`Next ${w} days`}
        notEnoughHistory={data.income.notEnoughHistory}
        trailing={data.income.trailing}
        projectedDaily={data.income.projectedDaily}
        toneClass="text-emerald-600 dark:text-emerald-400"
      />

      <OutlookTile
        variant="flow"
        title="Expenses"
        actual={data.expenses.actual}
        actualLabel={`Last ${w} days`}
        projected={data.expenses.projected}
        projectedLabel={`Next ${w} days`}
        notEnoughHistory={data.expenses.notEnoughHistory}
        trailing={data.expenses.trailing}
        projectedDaily={data.expenses.projectedDaily}
        toneClass="text-rose-600 dark:text-rose-400"
      />

      <OutlookTile
        variant="stock"
        title="Invoices"
        actual={data.invoices.actual}
        actualLabel="Open balance"
        projected={data.invoices.projected}
        projectedLabel={`Due in next ${w} days`}
        emptyLabel="No open invoices"
        noneDueLabel={`None due in next ${w} days`}
        toneClass="bg-sky-500 dark:bg-sky-400"
      />

      <OutlookTile
        variant="stock"
        title="Bills"
        actual={data.bills.actual}
        actualLabel="Open balance"
        projected={data.bills.projected}
        projectedLabel={`Due in next ${w} days`}
        emptyLabel="No open bills"
        noneDueLabel={`None due in next ${w} days`}
        toneClass="bg-amber-500 dark:bg-amber-400"
      />
    </div>
  );
}
