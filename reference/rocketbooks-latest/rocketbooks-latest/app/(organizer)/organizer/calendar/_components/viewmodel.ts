/**
 * Shared, framework-agnostic calendar view-model helpers used by both the
 * server page (range + fetch + labels) and the client components (URL building
 * for the view menu / year drill-down). Keeping the URL scheme, anchor parsing,
 * and range math in one place is what keeps server links and client navigation
 * in agreement.
 *
 * URL scheme:
 *   ?view=<day|week|month|year|schedule>   (omitted when 'month' — the default)
 *   ?date=YYYY-MM-DD                        (anchor; omitted when it is today)
 * Legacy values still parse: view=calendar → month, view=list → schedule, and
 * the old ?month=YYYY-MM anchor is honored when ?date is absent.
 */

export type CalendarView = 'day' | 'week' | 'month' | 'year' | 'schedule';

export const CALENDAR_VIEWS: CalendarView[] = ['day', 'week', 'month', 'year', 'schedule'];

/** Single-letter keyboard shortcut per view (mirrors Google Calendar). */
export const VIEW_SHORTCUT: Record<CalendarView, string> = {
  day: 'D',
  week: 'W',
  month: 'M',
  year: 'Y',
  schedule: 'A',
};

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Local-time `YYYY-MM-DD` key. */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` key into a local-midnight Date. */
export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function todayMidnight(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Sunday on/before the given date (week start). */
export function weekStart(d: Date): Date {
  return addDays(d, -d.getDay());
}

/** Map raw/legacy view strings to a canonical view; defaults to 'month'. */
export function normalizeView(raw: string | undefined): CalendarView {
  if (raw === 'calendar') return 'month';
  if (raw === 'list') return 'schedule';
  if (raw === 'day' || raw === 'week' || raw === 'month' || raw === 'year' || raw === 'schedule') {
    return raw;
  }
  return 'month';
}

/** Build a clean query string for a (view, anchor). */
export function buildHref(view: CalendarView, anchorKey: string, todayKey: string): string {
  const parts: string[] = [];
  if (view !== 'month') parts.push(`view=${view}`);
  if (anchorKey !== todayKey) parts.push(`date=${anchorKey}`);
  return parts.length === 0 ? '?' : `?${parts.join('&')}`;
}

/** Anchor for the prev/next step in the given view's natural unit. */
export function shiftAnchor(view: CalendarView, anchor: Date, dir: -1 | 1): Date {
  switch (view) {
    case 'day':
      return addDays(anchor, dir);
    case 'week':
      return addDays(anchor, dir * 7);
    case 'year':
      return new Date(anchor.getFullYear() + dir, 0, 1);
    case 'month':
    case 'schedule':
    default:
      return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  }
}

/** Half-open [start, end) Date range the view needs to fetch. */
export function rangeFor(view: CalendarView, anchor: Date): { start: Date; end: Date } {
  switch (view) {
    case 'day': {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      return { start: s, end: addDays(s, 1) };
    }
    case 'week': {
      const s = weekStart(anchor);
      return { start: s, end: addDays(s, 7) };
    }
    case 'year': {
      const y = anchor.getFullYear();
      return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
    }
    case 'month':
    case 'schedule':
    default: {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      return { start: s, end: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
    }
  }
}

/** Human label for the toolbar, per view. */
export function viewLabel(view: CalendarView, anchor: Date): string {
  switch (view) {
    case 'day':
      return anchor.toLocaleDateString([], {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    case 'week': {
      const s = weekStart(anchor);
      const e = addDays(s, 6);
      const sameMonth = s.getMonth() === e.getMonth();
      const sameYear = s.getFullYear() === e.getFullYear();
      const left = s.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const right = e.toLocaleDateString([], {
        month: sameMonth ? undefined : 'short',
        day: 'numeric',
        year: 'numeric',
      });
      return sameYear ? `${left} – ${right}` : `${s.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} – ${right}`;
    }
    case 'year':
      return String(anchor.getFullYear());
    case 'month':
    case 'schedule':
    default:
      return `${MONTH_LABELS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }
}
