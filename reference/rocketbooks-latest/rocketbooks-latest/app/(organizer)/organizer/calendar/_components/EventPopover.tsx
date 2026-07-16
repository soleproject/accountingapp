'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { CalendarAppointment, RegardingOrgOption } from '../types';
import { EventDialog } from './EventDialog';

interface Props {
  appt: CalendarAppointment;
  /** Viewport rect of the clicked event, used to anchor the card. */
  anchor: DOMRect;
  /** False in the read-only demo workspace — hides edit/delete. */
  canWrite: boolean;
  /** Companies the user can set this event's "regarding" to. */
  regardingOptions: RegardingOrgOption[];
  onClose: () => void;
  /** Called after a successful edit/delete so the parent can refresh + clear state. */
  onChanged: () => void;
}

const CARD_WIDTH = 300;

function fmtWhen(startIso: string, endIso: string | null): string {
  const s = new Date(startIso);
  if (Number.isNaN(s.getTime())) return '';
  const day = s.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!endIso) return `${day} · ${t(s)}`;
  const e = new Date(endIso);
  return Number.isNaN(e.getTime()) ? `${day} · ${t(s)}` : `${day} · ${t(s)} – ${t(e)}`;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function EventPopover({ appt, anchor, canWrite, regardingOptions, onClose, onChanged }: Props) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local optimistic copy of the "regarding" org so the label updates
  // immediately on change, before the parent's router.refresh lands.
  const [orgId, setOrgId] = useState<string | null>(appt.organizationId);
  const [savingOrg, setSavingOrg] = useState(false);
  const orgName =
    regardingOptions.find((o) => o.id === orgId)?.name ?? appt.organizationName ?? null;

  const changeRegarding = useCallback(
    async (nextOrgId: string) => {
      if (!nextOrgId || nextOrgId === orgId) return;
      const prev = orgId;
      setOrgId(nextOrgId); // optimistic
      setError(null);
      setSavingOrg(true);
      try {
        const res = await fetch(`/api/organizer/appointments/${appt.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: nextOrgId }),
        });
        if (!res.ok) throw new Error(`could not update company (${res.status})`);
        // Refresh so the calendar's per-event label + any org-scoped context
        // re-resolve. Keeps the popover open via local state.
        router.refresh();
      } catch (err) {
        setOrgId(prev); // roll back
        setError((err as Error).message);
      } finally {
        setSavingOrg(false);
      }
    },
    [appt.id, orgId, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const join = useCallback(async () => {
    setError(null);
    setJoining(true);
    try {
      const res = await fetch(`/api/organizer/appointments/${appt.id}/video-join`, { method: 'POST' });
      const j = (await res.json()) as { roomName?: string; error?: string };
      if (!res.ok || !j.roomName) throw new Error(j.error ?? `could not start video (${res.status})`);
      router.push(`/video/join/${j.roomName}`);
    } catch (err) {
      setError((err as Error).message);
      setJoining(false);
    }
  }, [appt.id, router]);

  const remove = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/organizer/appointments/${appt.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }, [appt.id, onChanged]);

  // Anchor the card under the event, clamped into the viewport.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 8);

  const guests = (appt.guestEmails ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

  return (
    <>
      {/* Click-away backdrop (transparent) */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label={appt.title}
        style={{ position: 'fixed', left, top, width: CARD_WIDTH, maxHeight: '70vh' }}
        className="z-50 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-3 w-3 shrink-0 rounded-sm bg-emerald-500" aria-hidden="true" />
            <h3 className="text-base font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{appt.title}</h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canWrite && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Edit"
                className="text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
              ✕
            </button>
          </div>
        </div>

        <p className="mt-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">{fmtWhen(appt.startsAt, appt.endsAt)}</p>

        {appt.videoEnabled && (
          <button
            type="button"
            onClick={join}
            disabled={joining}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            {joining ? 'Starting…' : 'Join video'}
          </button>
        )}

        {!appt.videoEnabled && appt.location && (
          <p className="mt-3 break-words pl-5 text-sm">
            {isUrl(appt.location) ? (
              <a href={appt.location} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline dark:text-emerald-400">
                {appt.location}
              </a>
            ) : (
              <span className="text-zinc-700 dark:text-zinc-300">{appt.location}</span>
            )}
          </p>
        )}

        {guests.length > 0 && (
          <div className="mt-3 pl-5">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {guests.length} {guests.length === 1 ? 'guest' : 'guests'}
            </p>
            <ul className="mt-1 space-y-0.5 text-sm text-zinc-700 dark:text-zinc-300">
              {guests.map((g) => (
                <li key={g} className="truncate">{g}</li>
              ))}
            </ul>
          </div>
        )}

        {appt.contactName && (
          <p className="mt-3 pl-5 text-sm text-zinc-600 dark:text-zinc-400">With {appt.contactName}</p>
        )}

        {/* Regarding which of the user's companies. Editable when the user can
            write and has more than one accessible company; otherwise a label. */}
        <div className="mt-3 pl-5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Regarding
          </p>
          {canWrite && regardingOptions.length > 1 ? (
            <select
              value={orgId ?? ''}
              disabled={savingOrg}
              onChange={(e) => changeRegarding(e.target.value)}
              className="mt-0.5 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              {orgId === null && <option value="">— No company —</option>}
              {regardingOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">
              {orgName ?? 'No company'}
            </p>
          )}
        </div>

        {error && <p className="mt-2 pl-5 text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        {canWrite && (
          <div className="mt-3 flex items-center justify-end gap-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-600 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-rose-400"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <EventDialog
          editId={appt.id}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
