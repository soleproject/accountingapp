import Link from 'next/link';
import { BillsClient } from './_components/BillsClient';

interface PageProps {
  searchParams: Promise<{ page?: string; filter?: string }>;
}

export default async function BillsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.page) query.set('page', sp.page);
  if (sp.filter) query.set('filter', sp.filter);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bills</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Vendor bill register and payables aging</p>
        </div>
        <Link href="/bills/new" prefetch={false} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          + New bill
        </Link>
      </header>
      <BillsClient query={queryString} />
    </div>
  );
}
