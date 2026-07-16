import { notFound } from 'next/navigation';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { EditAccountForm } from '../../_components/EditAccountForm';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditAccountPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  // Single query scoped to org — protects against guessing another org's
  // account id. If not found (or wrong org), 404.
  const [account] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      detailType: chartOfAccounts.detailType,
      parentAccountId: chartOfAccounts.parentAccountId,
      normalBalance: chartOfAccounts.normalBalance,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) notFound();

  // Potential parents = every other account in the org. We exclude the row
  // itself client-side in the form too, but filter here so a row can never
  // see its own descendants in the dropdown either (would create a cycle).
  // Cycle prevention is left to the form for now — small CoAs make this
  // unlikely to matter in practice.
  const potentialParents = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), ne(chartOfAccounts.id, id)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Edit account</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {account.accountNumber} · {account.accountName}
        </p>
      </header>
      <EditAccountForm account={account} potentialParents={potentialParents} />
    </div>
  );
}
