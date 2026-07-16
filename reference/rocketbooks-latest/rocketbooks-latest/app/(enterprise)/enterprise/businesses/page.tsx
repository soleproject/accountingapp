import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminPage } from '@/components/admin/AdminPage';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { getEnterpriseClientHealth } from '@/lib/enterprise/client-health';
import { getDemoFirmHealth, DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { ClientBusinessesTable } from '../_components/ClientBusinessesTable';
import { DashboardSearch } from '../_components/DashboardSearch';

export const dynamic = 'force-dynamic';

export default async function ClientBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const sp = await searchParams;
  const sort: 'alpha' | 'owner' = sp.sort === 'owner' ? 'owner' : 'alpha';

  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const isDemo = current.id === DEMO_ENTERPRISE_ID;
  const health = isDemo ? getDemoFirmHealth() : await getEnterpriseClientHealth(current.id);

  const sortBtn = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
        : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
    }`;

  return (
    <AdminPage
      title="Client Businesses"
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Client Businesses' },
      ]}
      actions={
        isDemo ? undefined : (
          <Link
            href="/enterprise/clients/add-company"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            + Add a company
          </Link>
        )
      }
    >
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {health.clients.length} {health.clients.length === 1 ? 'business' : 'businesses'} · click a business name for its
        bookkeeping view, or an owner for their account.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href="/enterprise/businesses" className={sortBtn(sort === 'alpha')}>Alphabetical</Link>
        <Link href="/enterprise/businesses?sort=owner" className={sortBtn(sort === 'owner')}>Grouped by owner</Link>
      </div>
      <DashboardSearch>
        <ClientBusinessesTable clients={health.clients} isDemo={isDemo} sort={sort} />
      </DashboardSearch>
    </AdminPage>
  );
}
