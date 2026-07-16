import { eq, asc, and, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { BillForm } from '../_components/BillForm';
import { createBill } from '../_actions/createBill';

const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];
const AP_TYPES = ['liability', 'current_liability'];

export default async function NewBillPage() {
  const orgId = await getCurrentOrgId();
  const [contactList, accounts] = await Promise.all([
    // Filter to vendor-tagged contacts only — a customer should never appear
    // in a bill's vendor dropdown. Untagged contacts are also shown so legacy
    // un-tagged data still reaches the form.
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, orgId),
          eq(contacts.isActive, true),
          sql`(${contacts.typeTags}::jsonb @> '["vendor"]'::jsonb OR ${contacts.typeTags}::jsonb = '[]'::jsonb)`,
        ),
      )
      .orderBy(asc(contacts.contactName)),
    db.select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType, detailType: chartOfAccounts.detailType }).from(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true))).orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const expenseAccounts = accounts.filter((a) => EXPENSE_TYPES.includes((a.gaapType ?? '').toLowerCase()));
  // Tighten the AP match: prefer detail_type=accounts_payable, then a strict
  // name match. Avoids "Sales Tax Payable" appearing as an AP option.
  const apCandidates = accounts.filter((a) => {
    const t = (a.gaapType ?? '').toLowerCase();
    if (!AP_TYPES.includes(t)) return false;
    const dt = (a.detailType ?? '').toLowerCase();
    if (dt === 'accounts_payable') return true;
    const name = a.accountName.toLowerCase();
    return name === 'accounts payable' || name.startsWith('accounts payable ') || name.endsWith(' a/p');
  });
  const apAccounts = apCandidates.length > 0 ? apCandidates : accounts.filter((a) => AP_TYPES.includes((a.gaapType ?? '').toLowerCase()));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New bill</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Posting creates a JE: debit expense lines, credit AP</p>
      </header>
      <BillForm
        contacts={contactList}
        expenseAccounts={expenseAccounts}
        apAccounts={apAccounts}
        action={createBill}
      />
    </div>
  );
}
