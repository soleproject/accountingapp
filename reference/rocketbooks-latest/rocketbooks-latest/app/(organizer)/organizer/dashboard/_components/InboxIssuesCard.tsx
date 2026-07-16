import { CollapsibleCard } from './CollapsibleCard';
import { InboxIssueItem } from './InboxIssueItem';

interface InboxMessage {
  id: string;
  source: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  body: string;
  receivedAt: string;
  contactId: string | null;
  contactName: string | null;
}

interface Props {
  messages: InboxMessage[];
  totalOpen: number;
  /** Demo org: the "mark reviewed" button hides optimistically but never persists. */
  demo: boolean;
}

export function InboxIssuesCard({ messages, totalOpen, demo }: Props) {
  const icon = (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 shadow-sm dark:bg-amber-900/40 dark:text-amber-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    </span>
  );
  const right =
    totalOpen > messages.length ? (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
        {totalOpen} open total
      </span>
    ) : undefined;

  return (
    <CollapsibleCard storageKey="rb-dash-collapse:inbox-issues" title="Inbox issues" icon={icon} right={right}>
      {messages.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Nothing waiting on you.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {messages.map((m) => (
            <InboxIssueItem key={m.id} message={m} demo={demo} />
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
