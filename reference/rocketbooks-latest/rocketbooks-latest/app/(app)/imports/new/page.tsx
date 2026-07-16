import { eq, asc, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { ImportForm } from '../_components/ImportForm';

export default async function NewImportPage() {
  const orgId = await getCurrentOrgId();
  const accounts = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Import transactions from CSV</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Required columns: <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">date</code>{' '}
          (YYYY-MM-DD), <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">description</code>,{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">amount</code> (positive number),{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">type</code> (deposit | withdrawal)
        </p>
      </header>
      <ImportForm accounts={accounts} />
    </div>
  );
}
