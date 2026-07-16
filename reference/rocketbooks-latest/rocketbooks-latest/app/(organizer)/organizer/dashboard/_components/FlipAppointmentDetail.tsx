'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCardFlip } from './CardFlipContext';
import { linkAppointmentContactAction } from '../_actions/appointments';

interface ContactOption {
  id: string;
  name: string;
}

function fmtWhen(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return '';
  const date = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!endIso) return `${date} · ${startTime}`;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return `${date} · ${startTime}`;
  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${startTime} – ${endTime}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortDue(due: string | null): string {
  if (!due) return '';
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return '';
  const diffDays = Math.floor((dueMs - Date.now()) / 86_400_000);
  if (diffDays < 0) return `${Math.abs(diffDays)}d late`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return new Date(dueMs).toLocaleDateString();
}

function SectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <h3 className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="opacity-70">{count}</span>}
    </h3>
  );
}

/** Card shell matching the dashboard cards; grows with its content (no inner scroll). */
function Shell({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="flex flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 shadow-sm dark:bg-sky-900/40 dark:text-sky-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </span>
          <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to tasks"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** Dropdown shown when no contact is linked, so the user can attach one and
 * unlock the appointment's related notes / tasks / emails / texts. */
function LinkContactControl({ appointmentId, contacts }: { appointmentId: string; contacts: ContactOption[] }) {
  const { refreshAppt } = useCardFlip();
  const router = useRouter();
  const [contactId, setContactId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const link = () => {
    if (!contactId) return;
    setError(null);
    start(async () => {
      const r = await linkAppointmentContactAction({ appointmentId, contactId });
      if (!r.ok) {
        setError(r.error ?? 'Could not link contact.');
        return;
      }
      // Reload the panel (related items now resolve) and the server-rendered
      // schedule row / link badges.
      refreshAppt();
      router.refresh();
    });
  };

  return (
    <div className="rounded-md bg-zinc-50 px-3 py-3 dark:bg-zinc-900">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        No contact is linked to this appointment. Link one to see their related notes, tasks, and communications.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          disabled={pending || contacts.length === 0}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">{contacts.length === 0 ? 'No contacts available' : 'Select a contact…'}</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={link}
          disabled={pending || !contactId}
          className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Linking…' : 'Link'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}

/**
 * Back face of the flipped Open Tasks card: shows the selected appointment's
 * purpose, open tasks, latest notes, emails, and texts. Mirrors the calendar
 * page's AppointmentDetailPanel, fed by the shared CardFlipContext fetch.
 */
export function FlipAppointmentDetail({ contacts }: { contacts: ContactOption[] }) {
  const { target, apptContext: context, apptLoading: loading, apptError: error, close } = useCardFlip();
  const title = target?.kind === 'appointment' ? target.title : 'Appointment';

  if (loading && !context) {
    return (
      <Shell onClose={close} title={title}>
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell onClose={close} title={title}>
        <p className="py-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      </Shell>
    );
  }

  if (!context) {
    return (
      <Shell onClose={close} title={title}>
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">No details.</p>
      </Shell>
    );
  }

  const { appointment: a, notes, tasks, emails, texts, textsEnabled } = context;

  return (
    <Shell onClose={close} title="Appointment">
      <div className="flex flex-col gap-4">
        {/* Header / when / contact */}
        <header className="min-w-0">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{a.title}</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{fmtWhen(a.startsAt, a.endsAt)}</p>
          {a.location && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{a.location}</p>}
          {a.contactId && a.contactName && (
            <Link
              href={`/organizer/contacts/${a.contactId}`}
              className="mt-0.5 inline-block text-xs text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {a.contactName}
            </Link>
          )}
        </header>

        {a.description && (
          <div>
            <SectionHeading label="Purpose" />
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{a.description}</p>
          </div>
        )}

        {!a.contactId ? (
          <LinkContactControl appointmentId={a.id} contacts={contacts} />
        ) : (
          <>
            {/* Tasks */}
            <div>
              <SectionHeading label="Open tasks" count={tasks.length} />
              {tasks.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">No open tasks.</p>
              ) : (
                <ul className="mt-1 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
                  {tasks.map((t) => {
                    const due = shortDue(t.dueDate);
                    const overdue = t.dueDate ? Date.parse(t.dueDate) < Date.now() - 86_400_000 : false;
                    return (
                      <li key={t.id} className="flex items-start justify-between gap-2 py-1.5 text-sm">
                        <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">{t.title}</span>
                        {due && (
                          <span
                            className={`shrink-0 text-xs ${
                              overdue ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'
                            }`}
                          >
                            {due}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Notes */}
            <div>
              <SectionHeading label="Latest notes" count={notes.length} />
              {notes.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">No notes yet.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {notes.map((n) => (
                    <li key={n.id} className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                      <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{n.body}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        {n.source} · {timeAgo(n.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Emails */}
            <div>
              <SectionHeading label="Emails" count={emails.length} />
              {emails.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">No emails.</p>
              ) : (
                <ul className="mt-1 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
                  {emails.map((m) => (
                    <li key={m.id} className="py-1.5 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-zinc-800 dark:text-zinc-200">{m.subject ?? '(no subject)'}</span>
                        <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-500">{timeAgo(m.receivedAt)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">
                        {m.body.slice(0, 140)}
                        {m.body.length > 140 ? '…' : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Texts */}
            {textsEnabled && (
              <div>
                <SectionHeading label="Texts" count={texts.length} />
                {texts.length === 0 ? (
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">No texts.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1.5">
                    {texts.map((t) => (
                      <li
                        key={t.id}
                        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm ${
                          t.direction === 'outbound'
                            ? 'ml-auto bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100'
                            : 'mr-auto bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{t.body}</p>
                        <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">{timeAgo(t.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
