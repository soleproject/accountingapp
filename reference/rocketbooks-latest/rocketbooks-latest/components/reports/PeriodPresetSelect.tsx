'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { PeriodPreset, PeriodPresetKey } from '@/lib/reports/date-presets';

interface Props {
  presets: PeriodPreset[];
  currentKey: PeriodPresetKey;
}

/**
 * Dropdown of "this month / last quarter / YTD / …" presets for period
 * reports. Selecting a preset rewrites `from` and `to` in the URL and
 * preserves every other query param (mode, accountId, etc.) so toggle and
 * filter state survive the navigation.
 *
 * "Custom…" is a no-op — the user adjusts the date inputs themselves.
 */
export function PeriodPresetSelect({ presets, currentKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const key = e.currentTarget.value as PeriodPresetKey;
    const preset = presets.find((p) => p.key === key);
    if (!preset || !preset.range) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('from', preset.range.from);
    next.set('to', preset.range.to);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <select
      value={currentKey}
      onChange={onChange}
      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      aria-label="Date range preset"
    >
      {presets.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
