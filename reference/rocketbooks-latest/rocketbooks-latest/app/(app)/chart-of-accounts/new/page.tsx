import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { AccountForm } from '../_components/AccountForm';

export default async function NewAccountPage() {
  const orgId = await getCurrentOrgId();
  const accounts = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId))
    .orderBy(asc(chartOfAccounts.accountNumber));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New account</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Add an account to your chart of accounts</p>
      </header>
      <AccountForm potentialParents={accounts} />
    </div>
  );
}
