import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc, sql, desc, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts, bills, billLines, journalEntries, journalEntryLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { BillForm, type BillFormInitial } from '../../_components/BillForm';
import { updateBill } from '../_actions/updateBill';

const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];
const AP_TYPES = ['liability', 'current_liability'];

interface PageProps { params: Promise<{ id: string }>; }

export default async function EditBillPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  const [bill] = await db
    .select({
      id: bills.id,
      contactId: bills.contactId,
      billNumber: bills.billNumber,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      memo: bills.memo,
      status: bills.status,
      taxAmount: bills.taxAmount,
    })
    .from(bills)
    .where(and(eq(bills.id, id), eq(bills.organizationId, orgId)))
    .limit(1);
  if (!bill) notFound();

  // Find the active (un-reversed) bill JE so we can prefill the
  // expenseAccountId / apAccountId from the existing posting.
  const [activeJe] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.organizationId, orgId),
        eq(journalEntries.sourceType, 'bill'),
        eq(journalEntries.sourceId, id),
        isNull(journalEntries.reversalOfId),
      ),
    )
    .orderBy(desc(journalEntries.createdAt))
    .limit(1);

  const [lineRows, jeLineRows, contactList, accounts] = await Promise.all([
    db
      .select({
        id: billLines.id,
        description: billLines.description,
        quantity: billLines.quantity,
        unitPrice: billLines.unitPrice,
      })
      .from(billLines)
      .where(eq(billLines.billId, id))
      .orderBy(asc(billLines.id)),
    activeJe
      ? db
          .select({
            accountId: journalEntryLines.accountId,
            debit: journalEntryLines.debit,
            credit: journalEntryLines.credit,
          })
          .from(journalEntryLines)
          .where(eq(journalEntryLines.journalEntryId, activeJe.id))
      : Promise.resolve([] as Array<{ accountId: string | null; debit: string | null; credit: string | null }>),
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
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        detailType: chartOfAccounts.detailType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const expenseAccounts = accounts.filter((a) => EXPENSE_TYPES.includes((a.gaapType ?? '').toLowerCase()));
  const apCandidates = accounts.filter((a) => {
    const t = (a.gaapType ?? '').toLowerCase();
    if (!AP_TYPES.includes(t)) return false;
    const dt = (a.detailType ?? '').toLowerCase();
    if (dt === 'accounts_payable') return true;
    const name = a.accountName.toLowerCase();
    return name === 'accounts payable' || name.startsWith('accounts payable ') || name.endsWith(' a/p');
  });
  const apAccounts = apCandidates.length > 0 ? apCandidates : accounts.filter((a) => AP_TYPES.includes((a.gaapType ?? '').toLowerCase()));

  // Identify AP and per-line expense accounts from the JE. AP is the credit
  // line; expense is on debits. Bills don't store these directly so this is
  // the only way to round-trip them through the form.
  const apFromJe = jeLineRows.find((l) => Number(l.credit ?? 0) > 0)?.accountId ?? null;
  const expenseAccountIds = jeLineRows
    .filter((l) => Number(l.debit ?? 0) > 0 && l.accountId)
    .map((l) => l.accountId as string);

  const apAccountIdInitial =
    apFromJe ?? (apAccounts[0]?.id ?? '');

  const boundUpdate = updateBill.bind(null, id);

  const initial: BillFormInitial = {
    contactId: bill.contactId,
    billNumber: bill.billNumber ?? '',
    billDate: bill.billDate,
    dueDate: bill.dueDate ?? '',
    memo: bill.memo ?? '',
    apAccountId: apAccountIdInitial,
    postNow: bill.status === 'posted',
    taxAmount: Number(bill.taxAmount) > 0 ? String(bill.taxAmount) : '',
    lines: lineRows.map((l, i) => ({
      description: l.description ?? '',
      quantity: String(l.quantity ?? '1'),
      unitPrice: String(l.unitPrice ?? '0'),
      // Round-trip the expense account from the JE when we have one. If
      // there are fewer JE expense lines than bill lines (multi-line
      // collapsed by SUM in the JE), fall back to the first available
      // expense account for the user to re-pick.
      expenseAccountId: expenseAccountIds[i] ?? expenseAccountIds[0] ?? '',
    })),
  };

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/bills/${id}`} className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to bill
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Edit bill</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {bill.status === 'posted'
            ? 'Saving will reverse the existing journal entry and post a new one.'
            : 'Draft bill. Saving with the post box checked will create a journal entry.'}
        </p>
      </header>
      <BillForm
        contacts={contactList}
        expenseAccounts={expenseAccounts}
        apAccounts={apAccounts}
        action={boundUpdate}
        initial={initial}
        submitDraftLabel="Save changes"
        submitPostLabel="Save & Post"
      />
    </div>
  );
}
