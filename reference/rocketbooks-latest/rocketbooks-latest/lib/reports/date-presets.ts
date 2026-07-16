/**
 * Date-range presets for the reporting pages. Pure utility module — safe to
 * import from server components AND client components (no `server-only`
 * directive). Server pages compute the preset list once and pass it to the
 * client `<PeriodPresetSelect>` / `<AsOfPresetSelect>` so the dropdown stays
 * in sync with the URL without a second pass on the client.
 */

export type PeriodPresetKey =
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'ytd'
  | 'last_year'
  | 'last_12_months'
  | 'custom';

export interface PeriodPreset {
  key: PeriodPresetKey;
  label: string;
  /** null on the `custom` entry — the user picks via the date inputs. */
  range: { from: string; to: string } | null;
}

export type AsOfPresetKey =
  | 'today'
  | 'end_last_month'
  | 'end_last_quarter'
  | 'end_last_year'
  | 'custom';

export interface AsOfPreset {
  key: AsOfPresetKey;
  label: string;
  /** null on the `custom` entry. */
  date: string | null;
}

const fmtIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfQuarter = (d: Date): Date => {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
};
const endOfQuarter = (d: Date): Date => {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3 + 3, 0);
};
const startOfYear = (d: Date): Date => new Date(d.getFullYear(), 0, 1);
const endOfYear = (d: Date): Date => new Date(d.getFullYear(), 11, 31);
const addMonths = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth() + n, d.getDate());

export function getPeriodPresets(today: Date = new Date()): PeriodPreset[] {
  const lastMonth = addMonths(today, -1);
  const lastQuarter = addMonths(today, -3);
  const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  return [
    {
      key: 'this_month',
      label: 'This month',
      range: { from: fmtIso(startOfMonth(today)), to: fmtIso(today) },
    },
    {
      key: 'last_month',
      label: 'Last month',
      range: { from: fmtIso(startOfMonth(lastMonth)), to: fmtIso(endOfMonth(lastMonth)) },
    },
    {
      key: 'this_quarter',
      label: 'This quarter',
      range: { from: fmtIso(startOfQuarter(today)), to: fmtIso(today) },
    },
    {
      key: 'last_quarter',
      label: 'Last quarter',
      range: { from: fmtIso(startOfQuarter(lastQuarter)), to: fmtIso(endOfQuarter(lastQuarter)) },
    },
    {
      key: 'ytd',
      label: 'Year to date',
      range: { from: fmtIso(startOfYear(today)), to: fmtIso(today) },
    },
    {
      key: 'last_year',
      label: 'Last year',
      range: { from: fmtIso(startOfYear(lastYear)), to: fmtIso(endOfYear(lastYear)) },
    },
    {
      key: 'last_12_months',
      label: 'Last 12 months',
      range: { from: fmtIso(addMonths(today, -12)), to: fmtIso(today) },
    },
    { key: 'custom', label: 'Custom…', range: null },
  ];
}

export function detectPeriodPreset(
  from: string,
  to: string,
  today: Date = new Date(),
): PeriodPresetKey {
  for (const p of getPeriodPresets(today)) {
    if (p.range && p.range.from === from && p.range.to === to) return p.key;
  }
  return 'custom';
}

export function getAsOfPresets(today: Date = new Date()): AsOfPreset[] {
  const lastMonth = addMonths(today, -1);
  const lastQuarter = addMonths(today, -3);
  const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  return [
    { key: 'today', label: 'Today', date: fmtIso(today) },
    { key: 'end_last_month', label: 'End of last month', date: fmtIso(endOfMonth(lastMonth)) },
    { key: 'end_last_quarter', label: 'End of last quarter', date: fmtIso(endOfQuarter(lastQuarter)) },
    { key: 'end_last_year', label: 'End of last year', date: fmtIso(endOfYear(lastYear)) },
    { key: 'custom', label: 'Custom…', date: null },
  ];
}

export function detectAsOfPreset(
  asOf: string,
  today: Date = new Date(),
): AsOfPresetKey {
  for (const p of getAsOfPresets(today)) {
    if (p.date && p.date === asOf) return p.key;
  }
  return 'custom';
}
