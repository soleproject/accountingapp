'use client';

import { useEffect, useState } from 'react';

export interface DashboardTab {
  label: string;
  content: React.ReactNode;
}

/**
 * One card with N tabs sharing the same space. Every tab body is
 * server-rendered and passed in via `tabs`; this client wrapper just toggles
 * which one is visible.
 */
export function DashboardTabs({ tabs, defaultIndex = 0 }: { tabs: DashboardTab[]; defaultIndex?: number }) {
  const [active, setActive] = useState(defaultIndex);

  // Allow other client code (the AI client-spotlight) to switch tabs by label
  // prefix, e.g. window.dispatchEvent(new CustomEvent('rs-dashboard-select-tab',
  // { detail: { label: 'Client Businesses' } })).
  useEffect(() => {
    const onSelect = (e: Event) => {
      const label = (e as CustomEvent<{ label?: string }>).detail?.label;
      if (!label) return;
      const idx = tabs.findIndex((t) => t.label.startsWith(label));
      if (idx >= 0) setActive(idx);
    };
    window.addEventListener('rs-dashboard-select-tab', onSelect as EventListener);
    return () => window.removeEventListener('rs-dashboard-select-tab', onSelect as EventListener);
  }, [tabs]);

  const tabClass = (isActive: boolean) =>
    `relative whitespace-nowrap px-5 py-3 text-sm font-medium transition-colors ${
      isActive
        ? 'text-zinc-900 dark:text-zinc-100'
        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap border-b border-zinc-200 dark:border-zinc-800" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={tabClass(active === i)}
          >
            {t.label}
            {active === i && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-blue-600" />}
          </button>
        ))}
      </div>
      <div className="p-5">{tabs[active]?.content}</div>
    </div>
  );
}
