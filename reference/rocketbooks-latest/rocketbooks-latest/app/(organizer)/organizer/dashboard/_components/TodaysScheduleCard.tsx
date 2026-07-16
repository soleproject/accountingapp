import { CollapsibleCard } from './CollapsibleCard';
import { GoogleDisconnectButton } from './GoogleDisconnectButton';
import { ScheduleAppointmentItem } from './ScheduleAppointmentItem';

interface Appointment {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  contactId: string | null;
  contactName: string | null;
  googleEventId: string | null;
  /** Company this meeting is "regarding" — shown as a small chip. */
  organizationName: string | null;
}

interface Props {
  appointments: Appointment[];
  google: {
    connected: 'ok' | 'auth_failed' | 'error' | false;
    accountEmail: string | null;
  };
  /** appointmentId → number of tasks linked to it (reverse link badge). */
  linkedTaskCounts?: Record<string, number>;
  /** appointmentIds whose meeting follow-up debrief is complete — shown green. */
  debriefDoneIds?: string[];
}

function ConnectGoogleButton() {
  return (
    <a
      href="/api/oauth/google/start"
      className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      Connect Google Calendar
    </a>
  );
}

export function TodaysScheduleCard({ appointments, google, linkedTaskCounts, debriefDoneIds }: Props) {
  const showConnectCta = google.connected === false;
  const showReconnectCta = google.connected === 'auth_failed';
  const doneSet = new Set(debriefDoneIds ?? []);

  const icon = (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 shadow-sm dark:bg-sky-900/40 dark:text-sky-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    </span>
  );

  const right =
    google.connected === 'ok' && google.accountEmail ? (
      <span
        className="flex shrink-0 items-center gap-1 truncate text-[10px] text-zinc-500 dark:text-zinc-500"
        title={`Synced with Google · ${google.accountEmail}`}
      >
        <span className="truncate">Google · {google.accountEmail}</span>
        <span aria-hidden="true">·</span>
        <GoogleDisconnectButton accountEmail={google.accountEmail} />
      </span>
    ) : undefined;

  return (
    <CollapsibleCard storageKey="rb-dash-collapse:todays-schedule" title="Today's schedule" icon={icon} right={right}>
      {appointments.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No appointments today.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {appointments.map((a) => (
            <ScheduleAppointmentItem
              key={a.id}
              appointment={a}
              debriefDone={doneSet.has(a.id)}
              linkedTaskCount={linkedTaskCounts?.[a.id] ?? 0}
            />
          ))}
        </ul>
      )}

      {(showConnectCta || showReconnectCta) && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-900">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
            {showReconnectCta
              ? 'Google Calendar lost authorization — reconnect to keep syncing.'
              : 'Connect Google Calendar to see your real appointments here.'}
          </p>
          <ConnectGoogleButton />
        </div>
      )}
    </CollapsibleCard>
  );
}
