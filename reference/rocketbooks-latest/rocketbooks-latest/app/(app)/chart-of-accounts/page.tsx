import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { CoaBrowser } from './_components/CoaBrowser';

interface PageProps {
  searchParams: Promise<{ showHidden?: string }>;
}

export default async function ChartOfAccountsPage({ searchParams }: PageProps) {
  const { showHidden: showHiddenParam } = await searchParams;
  const showHidden = showHiddenParam === '1';

  const orgId = await getCurrentOrgId();
  const allRows = await db
    .select({
      id: chartOfAccounts.id,
      parentAccountId: chartOfAccounts.parentAccountId,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      detailType: chartOfAccounts.detailType,
      normalBalance: chartOfAccounts.normalBalance,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId))
    .orderBy(asc(chartOfAccounts.accountNumber));

  const activeCount = allRows.filter((r) => r.isActive !== false).length;
  const hiddenCount = allRows.length - activeCount;
  const visibleRows = showHidden ? allRows : allRows.filter((r) => r.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Chart of Accounts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {activeCount.toLocaleString()} {activeCount === 1 ? 'account' : 'accounts'}
          </p>
        </div>
        <a href="/chart-of-accounts/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          + New account
        </a>
      </header>

      <CoaBrowser
        allRows={visibleRows}
        includesHidden={showHidden}
        hiddenCount={hiddenCount}
        toggleHiddenHref={showHidden ? '/chart-of-accounts' : '/chart-of-accounts?showHidden=1'}
        toggleHiddenLabel={showHidden ? `hide ${hiddenCount.toLocaleString()} inactive` : `show ${hiddenCount.toLocaleString()} hidden`}
      />
    </div>
  );
}
