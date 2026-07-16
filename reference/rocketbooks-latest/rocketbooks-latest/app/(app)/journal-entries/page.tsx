import Link from 'next/link';
import { JournalEntriesClient } from './_components/JournalEntriesClient';

interface PageProps {
  searchParams: Promise<{ accountId?: string; from?: string; to?: string; reversals?: string }>;
}

export default async function JournalEntriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.accountId) query.set('accountId', sp.accountId);
  if (sp.from) query.set('from', sp.from);
  if (sp.to) query.set('to', sp.to);
  if (sp.reversals) query.set('reversals', sp.reversals);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Journal Entries</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Browse posted entries by account and period</p>
        </div>
        <Link
          href="/journal-entries/new"
          prefetch={false}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + New manual JE
        </Link>
      </header>
      <JournalEntriesClient query={queryString} />
    </div>
  );
}
