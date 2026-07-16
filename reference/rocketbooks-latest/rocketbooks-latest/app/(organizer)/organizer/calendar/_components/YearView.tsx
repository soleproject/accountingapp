'use client';

import { useRouter } from 'next/navigation';
import type { CalendarAppointment } from '../types';
import { buildHref, dateKey } from './viewmodel';

interface Props {
  year: number;
  appointments: CalendarAppointment[];
  todayKey: string;
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function YearView({ year, appointments, todayKey }: Props) {
  const router = useRouter();

  // Which days have at least one appointment.
  const busy = new Set<string>();
  for (const a of appointments) busy.add(dateKey(new Date(a.startsAt)));

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {MONTH_LABELS.map((label, month) => {
        const first = new Date(year, month, 1);
        const gridStart = new Date(year, month, 1 - first.getDay());
        const cells = Array.from({ length: 42 }, (_, i) =>
          new Date(year, month, 1 - first.getDay() + i),
        );
        // Trim the trailing all-next-month week so short months don't show an
        // empty 6th row.
        const weeks = cells.some((d, i) => i >= 35 && d.getMonth() === month) ? 6 : 5;

        return (
          <div
            key={month}
            className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/20"
          >
            <button
              type="button"
              onClick={() => router.push(buildHref('month', dateKey(first), todayKey))}
              className="mb-2 text-sm font-semibold text-zinc-800 hover:text-emerald-600 dark:text-zinc-200 dark:hover:text-emerald-400"
            >
              {label}
            </button>
            <div className="grid grid-cols-7 text-center text-[10px] text-zinc-400 dark:text-zinc-600">
              {WEEKDAY_INITIALS.map((w, i) => (
                <div key={i} className="py-0.5">{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11px]">
              {cells.slice(0, weeks * 7).map((d) => {
                const key = dateKey(d);
                const inMonth = d.getMonth() === month;
                const isToday = key === todayKey;
                const hasEvents = busy.has(key) && inMonth;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => router.push(buildHref('day', key, todayKey))}
                    aria-label={d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
                    className={`relative mx-auto flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                      isToday
                        ? 'bg-emerald-600 font-semibold text-white dark:bg-emerald-500'
                        : inMonth
                          ? 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
                          : 'text-zinc-300 hover:bg-zinc-100 dark:text-zinc-700 dark:hover:bg-zinc-900'
                    }`}
                  >
                    {d.getDate()}
                    {hasEvents && !isToday && (
                      <span className="absolute bottom-0 h-1 w-1 rounded-full bg-emerald-500" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
