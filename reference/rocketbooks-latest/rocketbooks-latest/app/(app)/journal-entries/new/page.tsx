import { eq, asc, and, eq as eqFn } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { JournalEntryForm } from '../_components/JournalEntryForm';

export default async function NewJournalEntryPage() {
  const orgId = await getCurrentOrgId();

  const [accounts, contactList] = await Promise.all([
    db
      .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eqFn(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eqFn(contacts.isActive, true)))
      .orderBy(asc(contacts.contactName)),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">New journal entry</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Manual JE · debits must equal credits · at least one debit and one credit line
        </p>
      </header>
      <JournalEntryForm accounts={accounts} contacts={contactList} />
    </div>
  );
}
