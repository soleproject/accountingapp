'use client';

import Link from 'next/link';
import { useCardFlip, type FlipAppointment } from './CardFlipContext';

interface Appointment {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  contactId: string | null;
  contactName: string | null;
  googleEventId: string | null;
  /** Company this meeting is "regarding". */
  organizationName: string | null;
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
  if (!end) return start;
  return `${start} – ${end}`;
}

/**
 * A single Today's-schedule row. Clicking anywhere on the row flips the Open
 * Tasks card to this appointment's detail (purpose, notes, tasks, emails,
 * texts) via CardFlipContext; clicking the already-open appointment flips back
 * to the tasks panel — mirroring the Inbox / Texts cards. The contact link
 * stays independently clickable (stops propagation).
 */
export function ScheduleAppointmentItem({
  appointment: a,
  debriefDone,
  linkedTaskCount,
}: {
  appointment: Appointment;
  debriefDone: boolean;
  linkedTaskCount: number;
}) {
  const { open, close, target } = useCardFlip();
  const isActive = target?.kind === 'appointment' && target.id === a.id;

  const select = () => {
    if (isActive) {
      close();
      return;
    }
    const flip: FlipAppointment = { kind: 'appointment', id: a.id, title: a.title };
    open(flip);
  };

  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`Show details for ${a.title}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
      className={`-mx-2 cursor-pointer rounded-md px-2 py-2 text-sm transition-colors hover:bg-sky-50/60 dark:hover:bg-sky-950/20 ${
        isActive ? 'bg-sky-50 dark:bg-sky-950/30' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={`truncate ${
              debriefDone
                ? 'font-medium text-emerald-700 dark:text-emerald-400'
                : 'text-zinc-800 dark:text-zinc-200'
            }`}
          >
            {a.title}
          </span>
          {debriefDone && (
            <span
              className="shrink-0 rounded-full bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
              title="Meeting debrief complete"
            >
              ✓ Debriefed
            </span>
          )}
          {linkedTaskCount > 0 && (
            <span
              className="shrink-0 rounded-full bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
              title={`${linkedTaskCount} linked task(s)`}
            >
              🔗 {linkedTaskCount}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
          {fmtRange(a.startsAt, a.endsAt)}
        </span>
      </div>
      {(a.contactName || a.location) && (
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">
          {a.contactName &&
            (a.contactId ? (
              <Link
                href={`/organizer/contacts/${a.contactId}`}
                onClick={(e) => e.stopPropagation()}
                className="text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {a.contactName}
              </Link>
            ) : (
              a.contactName
            ))}
          {a.contactName && a.location ? ' · ' : ''}
          {a.location ?? ''}
        </p>
      )}
      {a.organizationName && (
        <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
          Regarding <span className="text-zinc-500 dark:text-zinc-400">{a.organizationName}</span>
        </p>
      )}
    </li>
  );
}
