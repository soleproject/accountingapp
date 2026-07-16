import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { chartOfAccounts, contacts, transactions } from '@/db/schema/schema';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { timeDb } from '@/lib/perf/db-timing';

const bankAccount = alias(chartOfAccounts, 'landing_bank_account');
const categoryAccount = alias(chartOfAccounts, 'landing_category_account');

export type TransactionLandingRow = {
  id: string;
  date: string | null;
  description: string | null;
  bankDescription: string | null;
  amount: number | null;
  type: string | null;
  contactName: string | null;
  categoryAccountName: string | null;
};

export async function loadTransactionsLanding(organizationId?: string): Promise<TransactionLandingRow[]> {
  await requirePermission('accounting.transactions.view');
  const orgId = organizationId ?? await getCurrentOrgId();
  return timeDb(
    'transactions.landingRows',
    () =>
      db
        .select({
          id: transactions.id,
          date: transactions.date,
          description: transactions.description,
          bankDescription: transactions.bankDescription,
          amount: transactions.amount,
          type: transactions.type,
          contactName: contacts.contactName,
          categoryAccountName: categoryAccount.accountName,
        })
        .from(transactions)
        .leftJoin(contacts, eq(transactions.contactId, contacts.id))
        .leftJoin(bankAccount, eq(transactions.accountId, bankAccount.id))
        .leftJoin(categoryAccount, eq(transactions.categoryAccountId, categoryAccount.id))
        .where(eq(transactions.organizationId, orgId))
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(10),
    { route: '/transactions/landing' },
  );
}
