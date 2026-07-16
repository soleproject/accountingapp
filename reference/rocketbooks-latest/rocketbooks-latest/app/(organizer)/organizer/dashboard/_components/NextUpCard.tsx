import Link from 'next/link';

interface TaskItem {
  kind: 'task';
  id: string;
  title: string;
  /** dueDate */
  when: string | null;
  priority: string | null;
}

interface AppointmentItem {
  kind: 'appointment';
  id: string;
  title: string;
  /** startsAt */
  when: string;
  endsAt: string | null;
  location: string | null;
  contactId: string | null;
  contactName: string | null;
  /** Meeting is imminent (≤ prep window) — render the "prepare" framing. */
  prep?: boolean;
  /** Open tasks linked to this meeting, shown as a prep checklist. */
  prepTasks?: { id: string; title: string }[];
}

export type NextUpItem = TaskItem | AppointmentItem;

interface Props {
  item: NextUpItem | null;
  /** Server-stamped "now" (ms) so relative-time badges match between SSR and
   *  hydration instead of drifting against the client's clock. */
  now: number;
}

function relativeDue(due: string | null, now: number): string {
  if (!due) return 'No due date';
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return 'No due date';
  const diffDays = Math.floor((dueMs - now) / 86_400_000);
  if (diffDays < -1) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === -1) return 'Overdue by 1 day';
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays <= 7) return `Due in ${diffDays} days`;
  return new Date(dueMs).toLocaleDateString();
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

/** "Starting now" / "in 25 min" / "in 2 hr 10 min" for an upcoming start time. */
function startsIn(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diffMin = Math.round((ms - now) / 60_000);
  if (diffMin <= 0) return 'Starting now';
  if (diffMin < 60) return `in ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h < 24) return m ? `in ${h} hr ${m} min` : `in ${h} hr`;
  return new Date(ms).toLocaleDateString();
}

function NextUpChip() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 shadow-sm dark:bg-indigo-900/40 dark:text-indigo-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    </span>
  );
}

function EmptyNextUp() {
  return (
    <section className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2.5">
        <NextUpChip />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Next up</h2>
      </div>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Nothing urgent. Nice. 🎉</p>
    </section>
  );
}

/** Shared spotlight shell: gradient card + chip header + a badge on the right. */
function Spotlight({
  label = 'Next up',
  badge,
  badgeTone,
  children,
}: {
  label?: string;
  badge: string;
  badgeTone: 'emerald' | 'rose';
  children: React.ReactNode;
}) {
  const toneClass =
    badgeTone === 'rose'
      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200';
  return (
    <section className="relative overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:via-zinc-900 dark:to-zinc-900">
      {/* soft decorative glow */}
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-indigo-400/10 blur-2xl dark:bg-indigo-500/10" aria-hidden="true" />
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <NextUpChip />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/80">{label}</h2>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold shadow-sm ${toneClass}`}>{badge}</span>
      </div>
      {children}
    </section>
  );
}

function MeetingSubtitle({ item }: { item: AppointmentItem }) {
  return (
    <p className="relative mt-1 text-xs text-zinc-500 dark:text-zinc-400">
      {fmtRange(item.when, item.endsAt)}
      {(item.contactName || item.location) && (
        <>
          {' · '}
          {item.contactId && item.contactName ? (
            <Link
              href={`/organizer/contacts/${item.contactId}`}
              className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
            >
              {item.contactName}
            </Link>
          ) : (
            item.contactName
          )}
          {item.contactName && item.location ? ' · ' : ''}
          {item.location ?? ''}
        </>
      )}
    </p>
  );
}

function AppointmentNextUp({ item, now }: { item: AppointmentItem; now: number }) {
  const prepTasks = item.prepTasks ?? [];
  const label = item.prep ? 'Prepare for upcoming meeting' : 'Next up';
  return (
    <Spotlight label={label} badge={startsIn(item.when, now)} badgeTone="emerald">
      <p className="relative mt-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{item.title}</p>
      <MeetingSubtitle item={item} />
      {item.prep && prepTasks.length > 0 && (
        <ul className="relative mt-3 flex flex-col gap-1.5 border-t border-indigo-100 pt-3 dark:border-indigo-900/40">
          {prepTasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 text-sm">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400">
                <rect x="3" y="3" width="18" height="18" rx="3" />
              </svg>
              <Link
                href={`/organizer/tasks/${t.id}/workspace`}
                className="text-zinc-700 hover:underline dark:text-zinc-300"
              >
                {t.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Spotlight>
  );
}

function TaskNextUp({ item, now }: { item: TaskItem; now: number }) {
  const isOverdue = item.when ? Date.parse(item.when) < now - 86_400_000 : false;
  return (
    <Spotlight badge={relativeDue(item.when, now)} badgeTone={isOverdue ? 'rose' : 'emerald'}>
      <Link
        href={`/organizer/tasks/${item.id}/workspace`}
        className="relative mt-3 block text-lg font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
      >
        {item.title}
      </Link>
      {item.priority && (
        <p className="relative mt-1 text-xs text-zinc-500 dark:text-zinc-400">Priority: {item.priority}</p>
      )}
    </Spotlight>
  );
}

export function NextUpCard({ item, now }: Props) {
  if (!item) return <EmptyNextUp />;
  return item.kind === 'appointment' ? <AppointmentNextUp item={item} now={now} /> : <TaskNextUp item={item} now={now} />;
}
