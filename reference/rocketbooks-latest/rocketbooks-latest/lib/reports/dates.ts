import 'server-only';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns the input if it's a valid YYYY-MM-DD date, otherwise the fallback.
 * Reports take ?asOf=/from=/to= from the URL; an unvalidated value flows
 * straight into a Postgres timestamp filter and surfaces the raw DB error to
 * the user. Always run query-string dates through this guard.
 */
export function safeIsoDate(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  if (!ISO_DATE.test(input)) return fallback;
  if (Number.isNaN(Date.parse(input))) return fallback;
  return input;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function yearStartIso(): string {
  return `${new Date().getFullYear()}-01-01`;
}
