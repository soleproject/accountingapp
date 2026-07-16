'use client';

import Link from 'next/link';
import type { CalendarAppointment } from '../types';

interface Props {
  /** Appointments for the selected month, already sorted ascending. */
  appointments: CalendarAppointment[];
  selectedId: string | null;
  onSelect: (id: string, anchor?: DOMRect) => void;
}

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

function fmtRange(startIso: string, endIso: string | null): string {
  const start = fmtTime(startIso);
  if (!endIso) return start;
  const end = fmtTime(endIso);
  return end ? `${start} – ${end}` : start;
}

function fmtDayHeading(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function AgendaList({ appointments, selectedId, onSelect }: Props) {
  if (appointments.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 shadow-md shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-black/30">
        No appointments this month.
      </div>
    );
  }

  // Group into day sections preserving chronological order.
  const groups: { key: string; iso: string; items: CalendarAppointment[] }[] = [];
  for (const a of appointments) {
    const key = dateKey(new Date(a.startsAt));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(a);
    else groups.push({ key, iso: a.startsAt, items: [a] });
  }

  const todayKey = dateKey(new Date());

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section
          key={g.key}
          className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-md shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30"
        >
          <h2 className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-emerald-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-emerald-300">
            {fmtDayHeading(g.iso)}
            {g.key === todayKey && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                Today
              </span>
            )}
          </h2>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {g.items.map((a) => {
              const selected = a.id === selectedId;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={(ev) => onSelect(a.id, ev.currentTarget.getBoundingClientRect())}
                    className={`flex w-full gap-4 px-4 py-3 text-left text-sm transition-colors ${
                      selected
                        ? 'bg-emerald-50 dark:bg-emerald-900/20'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
                    }`}
                  >
                    <span className="w-28 shrink-0 text-zinc-500 dark:text-zinc-400">
                      {fmtRange(a.startsAt, a.endsAt)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-zinc-800 dark:text-zinc-200">{a.title}</p>
                      {(a.contactName || a.location) && (
                        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">
                          {a.contactName ?? ''}
                          {a.contactName && a.location ? ' · ' : ''}
                          {a.location ?? ''}
                        </p>
                      )}
                      {a.organizationName && (
                        <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                          Regarding{' '}
                          <span className="text-zinc-500 dark:text-zinc-400">
                            {a.organizationName}
                          </span>
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
