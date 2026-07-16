import Link from 'next/link';
import { CollapsibleCard } from './CollapsibleCard';
import { TextIssueItem } from './TextIssueItem';

interface TextItem {
  id: string;
  body: string;
  createdAt: string;
  fromPhone: string;
  contactId: string | null;
  contactName: string | null;
}

interface Props {
  texts: TextItem[];
  totalUnread: number;
  /** Demo org: the "mark reviewed" button hides optimistically but never persists. */
  demo: boolean;
}

export function RecentTextsCard({ texts, totalUnread, demo }: Props) {
  const icon = (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 shadow-sm dark:bg-sky-900/40 dark:text-sky-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    </span>
  );
  const right = (
    <Link
      href="/organizer/texts"
      className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50"
    >
      {totalUnread > 0 ? `${totalUnread} to reply →` : 'Open →'}
    </Link>
  );

  return (
    <CollapsibleCard storageKey="rb-dash-collapse:texts" title="Texts" icon={icon} right={right}>
      {texts.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No texts waiting on a reply.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {texts.map((t) => (
            <TextIssueItem key={t.id} text={t} demo={demo} />
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
