import { eq, asc, and, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { InvoiceForm } from '../_components/InvoiceForm';
import { createInvoice } from '../_actions/createInvoice';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const AR_TYPES = ['asset', 'current_asset'];

export default async function NewInvoicePage() {
  const orgId = await getCurrentOrgId();

  const [contactList, accounts] = await Promise.all([
    // Filter to customer-tagged contacts only — a vendor should never appear
    // in an invoice's customer dropdown. Untagged contacts are also shown so
    // legacy un-tagged data still reaches the form.
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, orgId),
          eq(contacts.isActive, true),
          sql`(${contacts.typeTags}::jsonb @> '["customer"]'::jsonb OR ${contacts.typeTags}::jsonb = '[]'::jsonb)`,
        ),
      )
      .orderBy(asc(contacts.contactName)),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const revenueAccounts = accounts.filter((a) => REVENUE_TYPES.includes((a.gaapType ?? '').toLowerCase()));
  const arAccounts = accounts.filter((a) => {
    const t = (a.gaapType ?? '').toLowerCase();
    const name = a.accountName.toLowerCase();
    return AR_TYPES.includes(t) && (name.includes('receivable') || name.includes('a/r'));
  });
  const arFallback = arAccounts.length > 0 ? arAccounts : accounts.filter((a) => AR_TYPES.includes((a.gaapType ?? '').toLowerCase()));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New invoice</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Posting creates a JE: debit AR, credit revenue line(s)
        </p>
      </header>
      <InvoiceForm
        contacts={contactList}
        revenueAccounts={revenueAccounts}
        arAccounts={arFallback}
        action={createInvoice}
      />
    </div>
  );
}
