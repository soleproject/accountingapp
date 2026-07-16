// Date + money helpers for the reconciliation engine. All dates are handled as
// UTC ISO `YYYY-MM-DD` strings to line up with Postgres `date` columns.

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive first/last day of a calendar month (1-indexed month). */
export function monthBounds(year: number, month: number): { startDate: string; endDate: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this one
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

/** The (year, month) of the month immediately before the given month. */
export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Absolute whole-day distance between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

/** The day before an ISO date (used for opening-balance "as-of" = prior day). */
export function dayBefore(iso: string): string {
  return isoDate(new Date(Date.parse(iso) - 86_400_000));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? '?'} ${year}`;
}
