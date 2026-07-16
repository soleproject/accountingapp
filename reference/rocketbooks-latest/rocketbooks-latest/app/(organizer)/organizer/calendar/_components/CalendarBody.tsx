'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AppointmentContext, CalendarAppointment, RegardingOrgOption } from '../types';
import { MonthGrid } from './MonthGrid';
import { AgendaList } from './AgendaList';
import { TimeGrid } from './TimeGrid';
import { YearView } from './YearView';
import { AppointmentDetailPanel } from './AppointmentDetailPanel';
import { EventPopover } from './EventPopover';
import { parseKey, weekStart, type CalendarView } from './viewmodel';

interface Props {
  view: CalendarView;
  /** Anchor day as `YYYY-MM-DD`. */
  anchorKey: string;
  todayKey: string;
  appointments: CalendarAppointment[];
  /** False in the read-only demo workspace — hides edit/delete in the popover. */
  canWrite: boolean;
  /** Companies the user can set an event's "regarding" to. */
  regardingOptions: RegardingOrgOption[];
}

/**
 * Client shell that owns appointment selection. Clicking an event opens a
 * Google-style popover anchored at the event AND loads the right-side context
 * panel (notes/tasks/emails/texts) — both, by design. Selection is client
 * state (not a URL param) so opening it doesn't reload the page or re-run the
 * Google sync the server page does on each navigation.
 */
export function CalendarBody({ view, anchorKey, todayKey, appointments, canWrite, regardingOptions }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<AppointmentContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ appt: CalendarAppointment; anchor: DOMRect } | null>(null);

  const select = useCallback(
    async (id: string, anchor?: DOMRect) => {
      setSelectedId(id);
      if (anchor) {
        const appt = appointments.find((a) => a.id === id) ?? null;
        setPopover(appt ? { appt, anchor } : null);
      }
      setContext(null);
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(`/api/organizer/appointments/${id}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as AppointmentContext;
        // Guard against a stale response if the user clicked another event
        // while this request was in flight.
        setContext((prev) => (prev && prev.appointment.id !== id ? prev : data));
      } catch {
        setError('Could not load appointment details.');
      } finally {
        setLoading(false);
      }
    },
    [appointments],
  );

  const close = useCallback(() => {
    setSelectedId(null);
    setContext(null);
    setError(null);
  }, []);

  const onChanged = useCallback(() => {
    setPopover(null);
    setSelectedId(null);
    setContext(null);
    router.refresh();
  }, [router]);

  // Date/view changes swap the appointments set (server re-render). Drop the
  // selection + popover if the selected appointment is no longer on screen.
  useEffect(() => {
    if (selectedId && !appointments.some((a) => a.id === selectedId)) {
      setSelectedId(null);
      setContext(null);
      setError(null);
      setPopover(null);
    }
  }, [appointments, selectedId]);

  const anchor = parseKey(anchorKey);

  let main: React.ReactNode;
  if (view === 'month') {
    main = (
      <MonthGrid
        year={anchor.getFullYear()}
        month={anchor.getMonth()}
        appointments={appointments}
        selectedId={selectedId}
        onSelect={select}
      />
    );
  } else if (view === 'schedule') {
    main = <AgendaList appointments={appointments} selectedId={selectedId} onSelect={select} />;
  } else if (view === 'year') {
    main = <YearView year={anchor.getFullYear()} appointments={appointments} todayKey={todayKey} />;
  } else {
    // day | week — a time grid over 1 or 7 days.
    const start = view === 'week' ? weekStart(anchor) : anchor;
    const count = view === 'week' ? 7 : 1;
    const days = Array.from(
      { length: count },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
    main = <TimeGrid days={days} appointments={appointments} selectedId={selectedId} onSelect={select} />;
  }

  return (
    <>
      <div className={`grid gap-4 ${selectedId ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-1'}`}>
        <div className="min-w-0">{main}</div>
        {selectedId && (
          <AppointmentDetailPanel
            selectedId={selectedId}
            context={context}
            loading={loading}
            error={error}
            onClose={close}
          />
        )}
      </div>
      {popover && (
        <EventPopover
          appt={popover.appt}
          anchor={popover.anchor}
          canWrite={canWrite}
          regardingOptions={regardingOptions}
          onClose={() => setPopover(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
