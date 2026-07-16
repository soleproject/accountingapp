'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppointmentContext } from '../types';

interface Props {
  /** Present → edit an existing appointment (prefilled + PATCH); absent → create. */
  editId?: string;
  /** Create mode: pre-select this day (`YYYY-MM-DD`). */
  defaultDateKey?: string;
  onClose: () => void;
  /** Called after a successful save so the caller can refresh + close. */
  onSaved: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Next full hour, one-hour duration (create defaults). */
function defaultTimes(): { date: string; start: string; end: string } {
  const now = new Date();
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  const e = new Date(s.getTime() + 60 * 60 * 1000);
  return {
    date: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`,
    start: `${pad(s.getHours())}:${pad(s.getMinutes())}`,
    end: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
  };
}

/** ISO → local date + time strings for the form inputs. */
function splitLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function EventDialog({ editId, defaultDateKey, onClose, onSaved }: Props) {
  const d = defaultTimes();
  const [loading, setLoading] = useState(Boolean(editId));
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(defaultDateKey ?? d.date);
  const [start, setStart] = useState(d.start);
  const [end, setEnd] = useState(d.end);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [location, setLocation] = useState('');
  const [guests, setGuests] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit mode: load the appointment and prefill every field (so a PATCH that
  // sends all fields never wipes one we didn't show).
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/organizer/appointments/${editId}`);
        if (!res.ok) throw new Error(`load failed (${res.status})`);
        const { appointment: a } = (await res.json()) as AppointmentContext;
        if (cancelled) return;
        setTitle(a.title);
        const s = splitLocal(a.startsAt);
        setDate(s.date);
        setStart(s.time);
        if (a.endsAt) setEnd(splitLocal(a.endsAt).time);
        setVideoEnabled(Boolean(a.videoEnabled));
        setLocation(a.videoEnabled ? '' : a.location ?? '');
        setGuests(a.guestEmails ?? '');
        setDescription(a.description ?? '');
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useCallback(async () => {
    setError(null);
    if (!title.trim()) {
      setError('Add a title.');
      return;
    }
    const startsAt = new Date(`${date}T${start}`);
    const endsAt = new Date(`${date}T${end}`);
    if (Number.isNaN(startsAt.getTime())) {
      setError('Pick a valid date and start time.');
      return;
    }
    if (!Number.isNaN(endsAt.getTime()) && endsAt <= startsAt) {
      setError('End time must be after the start time.');
      return;
    }
    const guestEmails = guests
      .split(/[,\s]+/)
      .map((g) => g.trim())
      .filter(Boolean);

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        startsAt: startsAt.toISOString(),
        endsAt: Number.isNaN(endsAt.getTime()) ? null : endsAt.toISOString(),
        description: description.trim() || null,
        videoEnabled,
      };
      // Preserve a provisioned room: when video is on, leave `location` to the
      // server (don't overwrite it). When off, send the typed location.
      if (!videoEnabled) body.location = location.trim() || null;
      // Create needs an explicit null location for a video meeting (no room yet).
      if (!editId && videoEnabled) body.location = null;

      if (editId) {
        body.guestEmails = guestEmails;
      } else if (guestEmails.length > 0) {
        body.guestEmails = guestEmails;
      }

      const res = await fetch(
        editId ? `/api/organizer/appointments/${editId}` : '/api/organizer/appointments',
        {
          method: editId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `save failed (${res.status})`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [editId, title, date, start, end, videoEnabled, location, guests, description, onSaved]);

  const field =
    'block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-20" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md space-y-3 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {editId ? 'Edit event' : 'New event'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : (
          <>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add title"
              className={`${field} text-base`}
            />

            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-1 text-xs text-zinc-500 dark:text-zinc-400">
                Date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} mt-1`} />
              </label>
              <label className="col-span-1 text-xs text-zinc-500 dark:text-zinc-400">
                Start
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${field} mt-1`} />
              </label>
              <label className="col-span-1 text-xs text-zinc-500 dark:text-zinc-400">
                End
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${field} mt-1`} />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={videoEnabled}
                onChange={(e) => setVideoEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
              />
              Add RocketSuite video meeting
            </label>

            {videoEnabled ? (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
                A video room link is added automatically and opens when you join.
              </p>
            ) : (
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Location (optional)"
                className={field}
              />
            )}

            <input
              type="text"
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
              placeholder="Guest emails (comma-separated, optional)"
              className={field}
            />

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className={field}
            />

            {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
