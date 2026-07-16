const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return USD.format(n);
}

export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return USD_COMPACT.format(n);
}

export function fmtDay(iso: string): string {
  return SHORT_DATE.format(new Date(`${iso}T00:00:00Z`));
}
