'use client';

import type { CalendarAppointment } from '../types';

interface Props {
  /** 0-indexed month (0 = January). */
  year: number;
  month: number;
  appointments: CalendarAppointment[];
  selectedId: string | null;
  onSelect: (id: string, anchor?: DOMRect) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PER_CELL = 3;

/** Local-time `YYYY-MM-DD` key for grouping events into day cells. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function MonthGrid({ year, month, appointments, selectedId, onSelect }: Props) {
  // Bucket appointments by local day. Sorted ascending already from the
  // query, so each bucket stays chronological.
  const byDay = new Map<string, CalendarAppointment[]>();
  for (const a of appointments) {
    const key = dateKey(new Date(a.startsAt));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(a);
    else byDay.set(key, [a]);
  }

  // Grid starts on the Sunday on/before the 1st and spans 6 weeks (42
  // cells) so the layout height never jumps between months.
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  const todayKey = dateKey(new Date());

  const cells = Array.from({ length: 42 }, (_, i) => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    return {
      date,
      key: dateKey(date),
      inMonth: date.getMonth() === month,
      isToday: dateKey(date) === todayKey,
      events: byDay.get(dateKey(date)) ?? [],
    };
  });

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-md shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
      <div className="grid grid-cols-7 border-b border-zinc-200 bg-white text-xs font-medium text-emerald-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-emerald-300">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-2 text-center">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const overflow = cell.events.length - MAX_PER_CELL;
          return (
            <div
              key={cell.key}
              className="min-h-[6.5rem] border-b border-r border-zinc-200 bg-white p-1.5 last:border-r-0 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="mb-1 flex justify-end">
                <span
                  className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs ${
                    cell.isToday
                      ? 'bg-emerald-600 font-semibold text-white dark:bg-emerald-500'
                      : cell.inMonth
                        ? 'text-zinc-700 dark:text-zinc-300'
                        : 'text-zinc-400 dark:text-zinc-600'
                  }`}
                >
                  {cell.date.getDate()}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {cell.events.slice(0, MAX_PER_CELL).map((e) => {
                  const selected = e.id === selectedId;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={(ev) => onSelect(e.id, ev.currentTarget.getBoundingClientRect())}
                        title={`${fmtTime(e.startsAt)} ${e.title}${e.location ? ` · ${e.location}` : ''}`}
                        className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-xs transition-colors ${
                          selected
                            ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                            : 'bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-100 dark:hover:bg-emerald-900/50'
                        }`}
                      >
                        <span className="opacity-70">{fmtTime(e.startsAt)}</span>{' '}
                        <span className="font-medium">{e.title}</span>
                      </button>
                    </li>
                  );
                })}
                {overflow > 0 && (
                  <li className="px-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    +{overflow} more
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
