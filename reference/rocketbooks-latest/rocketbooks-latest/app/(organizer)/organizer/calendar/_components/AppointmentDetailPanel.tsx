'use client';

import Link from 'next/link';
import type { AppointmentContext } from '../types';

interface Props {
  selectedId: string | null;
  context: AppointmentContext | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function fmtWhen(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return '';
  const date = start.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
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

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <aside className="lg:sticky lg:top-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        {children}
      </div>
    </aside>
  );
}

export function AppointmentDetailPanel({ selectedId, context, loading, error, onClose }: Props) {
  if (!selectedId) {
    return (
      <PanelShell>
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Select an appointment to see its purpose, latest notes, tasks, and
          communications.
        </p>
      </PanelShell>
    );
  }

  if (loading && !context) {
    return (
      <PanelShell>
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      </PanelShell>
    );
  }

  if (error) {
    return (
      <PanelShell>
        <div className="flex items-start justify-between gap-2">
          <p className="py-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
          <CloseButton onClose={onClose} />
        </div>
      </PanelShell>
    );
  }

  if (!context) return null;

  const { appointment: a, notes, tasks, emails, texts, textsEnabled } = context;

  return (
    <PanelShell>
      <div className="flex flex-col gap-4">
        {/* Purpose */}
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {a.title}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {fmtWhen(a.startsAt, a.endsAt)}
            </p>
            {a.location && (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{a.location}</p>
            )}
            {a.contactId && a.contactName && (
              <Link
                href={`/organizer/contacts/${a.contactId}`}
                className="mt-0.5 inline-block text-xs text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {a.contactName}
              </Link>
            )}
            {a.organizationName && (
              <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                Regarding{' '}
                <span className="text-zinc-500 dark:text-zinc-400">{a.organizationName}</span>
              </p>
            )}
          </div>
          <CloseButton onClose={onClose} />
        </header>

        {a.description && (
          <div>
            <SectionHeading label="Purpose" />
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
              {a.description}
            </p>
          </div>
        )}

        {!a.contactId && (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            No contact is linked to this appointment, so there are no related
            notes, tasks, or communications to show.
          </p>
        )}

        {a.contactId && (
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
                    const overdue = t.dueDate
                      ? Date.parse(t.dueDate) < Date.now() - 86_400_000
                      : false;
                    return (
                      <li key={t.id} className="flex items-start justify-between gap-2 py-1.5 text-sm">
                        <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">
                          {t.title}
                        </span>
                        {due && (
                          <span
                            className={`shrink-0 text-xs ${
                              overdue
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-zinc-500 dark:text-zinc-400'
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
                    <li
                      key={n.id}
                      className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                    >
                      <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                        {n.body}
                      </p>
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
                        <span className="truncate text-zinc-800 dark:text-zinc-200">
                          {m.subject ?? '(no subject)'}
                        </span>
                        <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-500">
                          {timeAgo(m.receivedAt)}
                        </span>
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
                        <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                          {timeAgo(t.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </PanelShell>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close details"
      className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}
