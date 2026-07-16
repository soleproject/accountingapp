'use client';

import { useEffect, useRef } from 'react';
import type { CalendarAppointment } from '../types';
import { dateKey } from './viewmodel';

interface Props {
  /** Local-midnight days to render as columns (1 for day view, 7 for week). */
  days: Date[];
  appointments: CalendarAppointment[];
  selectedId: string | null;
  onSelect: (id: string, anchor?: DOMRect) => void;
}

const HOUR_PX = 48; // height of one hour row
const DAY_PX = HOUR_PX * 24;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

interface Positioned {
  ev: CalendarAppointment;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
}

/**
 * Lay out one day's events into non-overlapping columns. Events that overlap in
 * time are split side-by-side (interval-graph column packing): each cluster of
 * mutually overlapping events is divided into N columns of equal width.
 */
function layoutDay(events: CalendarAppointment[]): Positioned[] {
  const items = events
    .map((ev) => {
      const s = new Date(ev.startsAt);
      let startMin = s.getHours() * 60 + s.getMinutes();
      const e = ev.endsAt ? new Date(ev.endsAt) : null;
      // Default 60-min block; if end is missing/before start (or crosses into
      // the next day) clamp to a sane same-day block.
      let endMin = e ? e.getHours() * 60 + e.getMinutes() : startMin + 60;
      if (e && dateKey(e) !== dateKey(s)) endMin = 24 * 60;
      if (endMin <= startMin) endMin = startMin + 30;
      startMin = Math.max(0, Math.min(startMin, 24 * 60));
      endMin = Math.min(endMin, 24 * 60);
      return { ev, startMin, endMin };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const out: Positioned[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const cols: (typeof cluster)[] = [];
    for (const it of cluster) {
      let placed = false;
      for (const col of cols) {
        if (col[col.length - 1].endMin <= it.startMin) {
          col.push(it);
          placed = true;
          break;
        }
      }
      if (!placed) cols.push([it]);
    }
    const n = cols.length;
    cols.forEach((col, ci) =>
      col.forEach((it) =>
        out.push({
          ev: it.ev,
          topPx: (it.startMin / 60) * HOUR_PX,
          heightPx: Math.max(((it.endMin - it.startMin) / 60) * HOUR_PX, 16),
          leftPct: (ci / n) * 100,
          widthPct: 100 / n,
        }),
      ),
    );
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of items) {
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return out;
}

export function TimeGrid({ days, appointments, selectedId, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Open scrolled to ~7 AM so the morning is visible without scrolling.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX - 8;
  }, []);

  // Bucket appointments by local day key.
  const byDay = new Map<string, CalendarAppointment[]>();
  for (const a of appointments) {
    const key = dateKey(new Date(a.startsAt));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(a);
    else byDay.set(key, [a]);
  }

  const todayKey = dateKey(new Date());
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-md shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
      {/* Day header row */}
      <div
        className="grid border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        style={{ gridTemplateColumns: cols }}
      >
        <div className="px-1 py-2" />
        {days.map((d) => {
          const isToday = dateKey(d) === todayKey;
          return (
            <div key={dateKey(d)} className="border-l border-zinc-200 px-2 py-2 text-center dark:border-zinc-800">
              <div className="text-[11px] font-medium uppercase text-emerald-700 dark:text-emerald-300">
                {d.toLocaleDateString([], { weekday: 'short' })}
              </div>
              <div
                className={`mx-auto mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm ${
                  isToday
                    ? 'bg-emerald-600 font-semibold text-white dark:bg-emerald-500'
                    : 'text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Scrollable time body */}
      <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: cols }}>
          {/* Hour gutter */}
          <div className="relative" style={{ height: DAY_PX }}>
            {HOURS.map((h) => (
              <div key={h} className="h-12 pr-2 text-right">
                {h > 0 && (
                  <span className="relative -top-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                    {hourLabel(h)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d) => {
            const positioned = layoutDay(byDay.get(dateKey(d)) ?? []);
            return (
              <div
                key={dateKey(d)}
                className="relative border-l border-zinc-200 dark:border-zinc-800"
                style={{ height: DAY_PX }}
              >
                {/* Hour gridlines */}
                {HOURS.map((h) => (
                  <div key={h} className="h-12 border-t border-zinc-200 dark:border-zinc-800" />
                ))}
                {/* Positioned events */}
                {positioned.map((p) => {
                  const selected = p.ev.id === selectedId;
                  return (
                    <button
                      key={p.ev.id}
                      type="button"
                      onClick={(ev) => onSelect(p.ev.id, ev.currentTarget.getBoundingClientRect())}
                      title={`${fmtTime(p.ev.startsAt)} ${p.ev.title}${p.ev.location ? ` · ${p.ev.location}` : ''}`}
                      className={`absolute overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-xs leading-tight transition-colors ${
                        selected
                          ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-900/30 dark:text-emerald-100 dark:hover:bg-emerald-900/50'
                      }`}
                      style={{
                        top: p.topPx,
                        height: p.heightPx,
                        left: `calc(${p.leftPct}% + 2px)`,
                        width: `calc(${p.widthPct}% - 4px)`,
                      }}
                    >
                      <span className="block truncate font-medium">{p.ev.title}</span>
                      {p.heightPx >= 32 && (
                        <span className="block truncate opacity-75">{fmtTime(p.ev.startsAt)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
