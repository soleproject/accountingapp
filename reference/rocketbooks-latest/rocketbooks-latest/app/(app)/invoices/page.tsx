import Link from 'next/link';
import { InvoicesClient } from './_components/InvoicesClient';

interface PageProps {
  searchParams: Promise<{ page?: string; filter?: string }>;
}

export default async function InvoicesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.page) query.set('page', sp.page);
  if (sp.filter) query.set('filter', sp.filter);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Customer invoice register and receivables aging</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/invoices/follow-up" prefetch={false} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900">
            Follow up on overdue →
          </Link>
          <Link href="/invoices/new" prefetch={false} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
            + New invoice
          </Link>
        </div>
      </header>
      <InvoicesClient query={queryString} />
    </div>
  );
}
