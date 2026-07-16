'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { AsOfPreset, AsOfPresetKey } from '@/lib/reports/date-presets';

interface Props {
  presets: AsOfPreset[];
  currentKey: AsOfPresetKey;
}

/**
 * Dropdown of single-date presets for "as of" reports (BS, TB). Selecting
 * a preset rewrites `asOf` and preserves every other query param.
 */
export function AsOfPresetSelect({ presets, currentKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const key = e.currentTarget.value as AsOfPresetKey;
    const preset = presets.find((p) => p.key === key);
    if (!preset || !preset.date) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('asOf', preset.date);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <select
      value={currentKey}
      onChange={onChange}
      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      aria-label="As-of date preset"
    >
      {presets.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
