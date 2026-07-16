import { ContactsClient } from './_components/ContactsClient';

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; status?: string }>;
}

export default async function ContactsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  if (sp.page) query.set('page', sp.page);
  if (sp.q) query.set('q', sp.q);
  if (sp.status) query.set('status', sp.status);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Customer, vendor, and relationship records</p>
        </div>
      </header>
      <ContactsClient query={queryString} />
    </div>
  );
}
