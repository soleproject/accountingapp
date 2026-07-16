import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, contacts, transactionSplits, bills, billLines, payments, invoices, invoiceLines, receiptMatchApplications, receipts, trustBeneficiaries, journalEntryLines } from '@/db/schema/schema';
import { loadAllDimensionOptions } from '@/lib/tags/dimensions';
import { readJournalEntryTags } from '@/lib/tags/store';
import { getCurrentOrgId } from '@/lib/auth/org';
import { ManualTransactionForm, type ManualTransactionInitial, type BeneficiaryOption } from '../new/_components/ManualTransactionForm';
import { TagsPanel, type TagDimensionRender } from './_components/TagsPanel';
import { MarkReviewedButton } from './_components/MarkReviewedButton';
import { categorizeAdapter, splitAdapter, unsplitAdapter } from './_actions/manualFormAdapters';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { lookupBeneficiaryMemoryWithQualifyingCheck } from '@/lib/accounting/beneficiary-memory';
import { isIncapacitatedAsOf } from '@/lib/accounting/trust-reroute';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];

// Phase 4d: per-beneficiary account detail types. Mirrors the gate in
// categorize.ts and the rules engine.
const PER_BENEFICIARY_DETAIL_TYPES = [
  'trust_food_minors_incapacitated',
  'trust_clothing_minors_incapacitated',
  'trust_distributions_to_beneficiaries',
  'trust_medical_wellness',
] as const;
const FOOD_OR_CLOTHING_DETAIL_TYPES = new Set<string>([
  'trust_food_minors_incapacitated',
  'trust_clothing_minors_incapacitated',
]);

function ageYearsFromDob(dob: string, asOfDate: string): number | null {
  const birth = new Date(dob);
  const as = new Date(asOfDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
  let years = as.getUTCFullYear() - birth.getUTCFullYear();
  const m = as.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
  return years;
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ back?: string; backLabel?: string; mode?: string }>;
}

export default async function TransactionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { back, backLabel, mode } = await searchParams;
  const orgId = await getCurrentOrgId();
  // Only honor in-app back URLs (must start with "/") so a forged ?back=
  // can't redirect users off-site after they finish this page.
  const safeBack = back && back.startsWith('/') ? back : '/transactions';
  const safeBackLabel = backLabel && backLabel.trim() ? backLabel : 'transactions';

  const [txn] = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      amount: transactions.amount,
      type: transactions.type,
      reviewed: transactions.reviewed,
      verified: transactions.verified,
      bankDescription: transactions.bankDescription,
      userDescription: transactions.userDescription,
      categoryAccountId: transactions.categoryAccountId,
      contactId: transactions.contactId,
      accountId: transactions.accountId,
      journalEntryId: transactions.journalEntryId,
    })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) notFound();

  const [accounts, contactList, splitRows, trustEnabled] = await Promise.all([
    db
      .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType, accountType: chartOfAccounts.accountType, detailType: chartOfAccounts.detailType })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.contactName)),
    db
      .select({
        id: transactionSplits.id,
        categoryAccountId: transactionSplits.categoryAccountId,
        amount: transactionSplits.amount,
        memo: transactionSplits.memo,
        contactId: transactionSplits.contactId,
        intent: transactionSplits.intent,
        intentTargetId: transactionSplits.intentTargetId,
        position: transactionSplits.position,
      })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, id))
      .orderBy(asc(transactionSplits.position)),
    getOrgFeature(orgId, 'beneficial_trust'),
  ]);

  // Phase 4d: per-line beneficiary picker data. Only fetched on trust orgs.
  // perBeneficiaryAccountIds is the chart_of_accounts.id set the form uses
  // to decide whether to render the picker on category change; the picker
  // gates required-ness on food/clothing via foodOrClothingAccountIds.
  let beneficiaryOptions: BeneficiaryOption[] = [];
  let perBeneficiaryAccountIds: string[] = [];
  let foodOrClothingAccountIds: string[] = [];
  let initialBeneficiaryId: string | null = null;
  if (trustEnabled) {
    const trustAccounts = accounts.filter(
      (a) => a.detailType && (PER_BENEFICIARY_DETAIL_TYPES as readonly string[]).includes(a.detailType),
    );
    perBeneficiaryAccountIds = trustAccounts.map((a) => a.id);
    foodOrClothingAccountIds = trustAccounts
      .filter((a) => a.detailType && FOOD_OR_CLOTHING_DETAIL_TYPES.has(a.detailType))
      .map((a) => a.id);

    const beneRows = await db
      .select({
        id: trustBeneficiaries.id,
        fullName: trustBeneficiaries.fullName,
        dateOfBirth: trustBeneficiaries.dateOfBirth,
        isIncapacitated: trustBeneficiaries.isIncapacitated,
        incapacitatedSince: trustBeneficiaries.incapacitatedSince,
        notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
      })
      .from(trustBeneficiaries)
      .where(eq(trustBeneficiaries.organizationId, orgId))
      .orderBy(asc(trustBeneficiaries.fullName));

    // Qualification is "as of the txn date" so picking an old txn shows the
    // beneficiary's age at the time AND respects the incapacitation
    // effective-date columns (so a beneficiary who recovered after the txn
    // date still passes the qualifying check for that historical post).
    const asOf = txn.date ?? new Date().toISOString().slice(0, 10);
    beneficiaryOptions = beneRows.map((b) => {
      const ageYears = b.dateOfBirth ? ageYearsFromDob(b.dateOfBirth, asOf) : null;
      const incapacitatedAtDate = isIncapacitatedAsOf(b, asOf);
      const qualifies = incapacitatedAtDate || (ageYears !== null && ageYears < 21);
      const ageNote = incapacitatedAtDate
        ? 'incapacitated'
        : ageYears !== null
          ? `age ${ageYears}`
          : 'age unknown';
      return { id: b.id, fullName: b.fullName, qualifies, ageNote };
    });

    // Pull the existing category-line beneficiary_id off the txn's JE so
    // the picker prefills in edit mode. The category line is the side NOT
    // on the txn's bank account.
    if (txn.journalEntryId && txn.accountId) {
      const lines = await db
        .select({
          accountId: journalEntryLines.accountId,
          beneficiaryId: journalEntryLines.beneficiaryId,
        })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, txn.journalEntryId));
      const categoryLine = lines.find((l) => l.accountId !== txn.accountId);
      initialBeneficiaryId = categoryLine?.beneficiaryId ?? null;
    }

    // Vendor-memory fallback: when the txn doesn't have a beneficiary tag
    // yet but the category IS a per-beneficiary trust account, ask the
    // memory helper "did this merchant on this account get tagged to
    // someone before?". On hit, pre-fill the picker so the user just
    // confirms with one click instead of re-deriving the mapping.
    if (
      !initialBeneficiaryId
      && txn.categoryAccountId
      && perBeneficiaryAccountIds.includes(txn.categoryAccountId)
    ) {
      const asOf = txn.date ?? new Date().toISOString().slice(0, 10);
      const memoryHit = await lookupBeneficiaryMemoryWithQualifyingCheck({
        organizationId: orgId,
        categoryAccountId: txn.categoryAccountId,
        categoryDetailType:
          accounts.find((a) => a.id === txn.categoryAccountId)?.detailType ?? null,
        asOfDate: asOf,
        contactId: txn.contactId,
        description: txn.bankDescription ?? txn.description,
        type: txn.type,
      });
      initialBeneficiaryId = memoryHit?.beneficiaryId ?? null;
    }
  }

  // Tags panel data — load all dimension pickers + current values from
  // the polymorphic tag store. Adding a new tag dimension requires no
  // change here, just a new entry in lib/tags/dimensions.ts.
  const allDimensions = await loadAllDimensionOptions(orgId);
  const currentSnapshot = txn.journalEntryId && txn.accountId
    ? await readJournalEntryTags({
        journalEntryId: txn.journalEntryId,
        bankAccountId: txn.accountId,
      })
    : { tags: [] };
  const tagDimensions: TagDimensionRender[] = allDimensions.map(({ dimension, options }) => {
    const currentId = currentSnapshot.tags.find((t) => t.entityType === dimension.entityType)?.entityId ?? null;
    return {
      entityType: dimension.entityType,
      label: dimension.label,
      emoji: dimension.emoji,
      options,
      currentId,
      currentDetailHref:
        currentId && dimension.detailPath ? dimension.detailPath(currentId) : null,
    };
  });

  // Active receipt-match application, if any — lets the header render
  // a "Linked Receipt" pill and a link back to the receipt detail page.
  const [linkedReceipt] = await db
    .select({
      applicationId: receiptMatchApplications.id,
      receiptId: receiptMatchApplications.receiptId,
      receiptVendor: contacts.contactName,
    })
    .from(receiptMatchApplications)
    .leftJoin(receipts, eq(receiptMatchApplications.receiptId, receipts.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(
      and(
        eq(receiptMatchApplications.transactionId, id),
        sql`${receiptMatchApplications.reversedAt} IS NULL`,
      ),
    )
    .limit(1);

  // Directional payments linked to this transaction — at the single-mode
  // level (transactionSplitId is null) or per split line. Used to seed
  // the picker with intent=bill_payment / invoice_payment so it shows
  // the bill / invoice label instead of the AP / AR account name.
  const paymentRows = await db
    .select({
      transactionSplitId: payments.transactionSplitId,
      type: payments.type,
      billId: payments.billId,
      invoiceId: payments.invoiceId,
    })
    .from(payments)
    .where(and(eq(payments.transactionId, id), eq(payments.organizationId, orgId)));
  const linkedBillIds = Array.from(
    new Set(
      paymentRows
        .filter((p) => p.type === 'sent')
        .map((p) => p.billId)
        .filter((v): v is string => !!v),
    ),
  );
  const linkedInvoiceIds = Array.from(
    new Set(
      paymentRows
        .filter((p) => p.type === 'received')
        .map((p) => p.invoiceId)
        .filter((v): v is string => !!v),
    ),
  );

  // Pull full info for any bill that's linked to this txn (open or paid),
  // merged with the org's open bills below so the picker can render a
  // bill label even for fully-paid bills.
  let linkedBills: Array<{
    id: string;
    billNumber: string | null;
    vendorName: string | null;
    balance: number;
    contactId: string | null;
  }> = [];
  if (linkedBillIds.length > 0) {
    const billRows = await db
      .select({
        id: bills.id,
        billNumber: bills.billNumber,
        contactId: bills.contactId,
        vendorName: contacts.contactName,
        total: sql<string>`COALESCE(SUM(${billLines.amount}), 0)`,
      })
      .from(bills)
      .leftJoin(billLines, eq(billLines.billId, bills.id))
      .leftJoin(contacts, eq(bills.contactId, contacts.id))
      .where(and(eq(bills.organizationId, orgId), inArray(bills.id, linkedBillIds)))
      .groupBy(bills.id, bills.billNumber, bills.contactId, contacts.contactName);
    const appliedPaymentsAll = await db
      .select({ billId: payments.billId, amount: payments.amount })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, orgId),
          eq(payments.type, 'sent'),
          inArray(payments.billId, linkedBillIds),
        ),
      );
    const appliedByBill = new Map<string, number>();
    for (const p of appliedPaymentsAll) {
      if (!p.billId) continue;
      appliedByBill.set(p.billId, (appliedByBill.get(p.billId) ?? 0) + p.amount);
    }
    linkedBills = billRows.map((b) => {
      const total = Number(b.total ?? 0);
      const applied = appliedByBill.get(b.id) ?? 0;
      return {
        id: b.id,
        billNumber: b.billNumber,
        vendorName: b.vendorName,
        balance: Math.max(0, total - applied),
        contactId: b.contactId,
      };
    });
  }

  // Parallel: invoices linked to received-payment rows for this txn.
  let linkedInvoices: Array<{
    id: string;
    invoiceNumber: string | null;
    customerName: string | null;
    balance: number;
    contactId: string | null;
  }> = [];
  if (linkedInvoiceIds.length > 0) {
    const invRows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        contactId: invoices.contactId,
        customerName: contacts.contactName,
        total: sql<string>`COALESCE(SUM(${invoiceLines.amount}), 0)`,
      })
      .from(invoices)
      .leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .leftJoin(contacts, eq(invoices.contactId, contacts.id))
      .where(and(eq(invoices.organizationId, orgId), inArray(invoices.id, linkedInvoiceIds)))
      .groupBy(invoices.id, invoices.invoiceNumber, invoices.contactId, contacts.contactName);
    const appliedInvAll = await db
      .select({ invoiceId: payments.invoiceId, amount: payments.amount })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, orgId),
          eq(payments.type, 'received'),
          inArray(payments.invoiceId, linkedInvoiceIds),
        ),
      );
    const appliedByInvoice = new Map<string, number>();
    for (const p of appliedInvAll) {
      if (!p.invoiceId) continue;
      appliedByInvoice.set(p.invoiceId, (appliedByInvoice.get(p.invoiceId) ?? 0) + p.amount);
    }
    linkedInvoices = invRows.map((i) => {
      const total = Number(i.total ?? 0);
      const applied = appliedByInvoice.get(i.id) ?? 0;
      return {
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        customerName: i.customerName,
        balance: Math.max(0, total - applied),
        contactId: i.contactId,
      };
    });
  }

  const accountLabel = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return accountId;
    return a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName;
  };

  const ttype = (txn.type ?? '').toLowerCase();
  const txnType: 'deposit' | 'withdrawal' | null =
    ttype === 'deposit' ? 'deposit' : ttype === 'withdrawal' ? 'withdrawal' : null;
  // "Account" dropdown lists asset (bank) and liability (credit card)
  // accounts — the kind of accounts a transaction can originate from.
  const bankAccounts = accounts.filter(
    (a) => a.accountType === 'bank' || (a.gaapType ?? '').toLowerCase() === 'liability',
  );
  // Same gating as the manual create flow: deposits split across income
  // accounts, withdrawals split across expense accounts.
  const categoryAccounts =
    txnType === 'deposit'
      ? accounts.filter((a) => REVENUE_TYPES.includes((a.gaapType ?? '').toLowerCase()))
      : txnType === 'withdrawal'
        ? accounts.filter((a) => EXPENSE_TYPES.includes((a.gaapType ?? '').toLowerCase()))
        : [];

  const contactLabel = (contactId: string | null) => {
    if (!contactId) return null;
    return contactList.find((c) => c.id === contactId)?.name ?? null;
  };

  // Outstanding bills feed "Payment Sent for a Bill" (withdrawal only),
  // outstanding invoices feed "Payment Received for an Invoice" (deposit
  // only). Each is merged with linkedBills/linkedInvoices so the picker
  // can render the label for a fully-paid target.
  const outstandingBillRows =
    txnType === 'withdrawal' ? await getOutstandingBills(orgId) : [];
  const allBillsById = new Map<string, { id: string; billNumber: string | null; vendorName: string | null; balance: number; contactId: string | null }>();
  for (const b of outstandingBillRows) {
    allBillsById.set(b.id, {
      id: b.id,
      billNumber: b.billNumber,
      vendorName: b.vendorName,
      balance: b.balance,
      contactId: b.contactId,
    });
  }
  for (const b of linkedBills) {
    if (!allBillsById.has(b.id)) allBillsById.set(b.id, b);
  }
  const outstandingBills = Array.from(allBillsById.values()).map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    vendorName: b.vendorName,
    contactId: b.contactId,
    balance: b.balance,
  }));

  const outstandingInvoiceRows =
    txnType === 'deposit' ? await getOutstandingInvoices(orgId) : [];
  const allInvoicesById = new Map<string, { id: string; invoiceNumber: string | null; customerName: string | null; balance: number; contactId: string | null }>();
  for (const i of outstandingInvoiceRows) {
    allInvoicesById.set(i.id, {
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      customerName: i.customerName,
      balance: i.balance,
      contactId: i.contactId,
    });
  }
  for (const i of linkedInvoices) {
    if (!allInvoicesById.has(i.id)) allInvoicesById.set(i.id, i);
  }
  const outstandingInvoices = Array.from(allInvoicesById.values()).map((i) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    customerName: i.customerName,
    contactId: i.contactId,
    balance: i.balance,
  }));

  // Single-mode directional payment is identified by a payments row WITHOUT
  // a transactionSplitId (the single-mode actions set only transactionId).
  // Type tells us which intent.
  const singleModeDirectional = paymentRows.find((p) => !p.transactionSplitId);
  let currentIntent: '' | 'bill_payment' | 'invoice_payment' = '';
  let currentIntentTargetId = '';
  if (singleModeDirectional?.type === 'sent' && singleModeDirectional.billId) {
    currentIntent = 'bill_payment';
    currentIntentTargetId = singleModeDirectional.billId;
  } else if (singleModeDirectional?.type === 'received' && singleModeDirectional.invoiceId) {
    currentIntent = 'invoice_payment';
    currentIntentTargetId = singleModeDirectional.invoiceId;
  }

  // Label for any split row that's a directional (bill or invoice) payment.
  const splitDirectionalLabel = (
    intent: string | null,
    intentTargetId: string | null,
  ): string | null => {
    if (!intentTargetId) return null;
    if (intent === 'bill_payment') {
      const b = allBillsById.get(intentTargetId);
      if (!b) return 'Bill payment';
      const num = b.billNumber ? `Bill #${b.billNumber}` : 'Bill';
      const vendor = b.vendorName ? ` | Payment to ${b.vendorName}` : '';
      return `${num}${vendor}`;
    }
    if (intent === 'invoice_payment') {
      const i = allInvoicesById.get(intentTargetId);
      if (!i) return 'Invoice payment';
      const num = i.invoiceNumber ? `Invoice #${i.invoiceNumber}` : 'Invoice';
      const customer = i.customerName ? ` | Payment from ${i.customerName}` : '';
      return `${num}${customer}`;
    }
    return null;
  };

  const splits = splitRows.map((r) => ({
    id: r.id,
    categoryLabel:
      splitDirectionalLabel(r.intent, r.intentTargetId) ?? accountLabel(r.categoryAccountId),
    contactLabel: contactLabel(r.contactId),
    memo: r.memo,
    amount: Number(r.amount),
  }));
  // Only seed per-line contactId when it diverges from the txn-level contact.
  // That way the form starts "clean" (no per-line override) for users who
  // never customized contact per line.
  const initialSplitLines = splitRows.map((r) => {
    const isDirectional = r.intent === 'bill_payment' || r.intent === 'invoice_payment';
    return {
      categoryAccountId: isDirectional ? '' : r.categoryAccountId,
      amount: Number(r.amount).toFixed(2),
      memo: r.memo ?? '',
      contactId: r.contactId && r.contactId !== txn.contactId ? r.contactId : '',
      intent: (r.intent === 'bill_payment'
        ? 'bill_payment'
        : r.intent === 'invoice_payment'
          ? 'invoice_payment'
          : '') as '' | 'bill_payment' | 'invoice_payment',
      intentTargetId: r.intentTargetId ?? '',
    };
  });

  const boundSplit = splitAdapter.bind(null, txn.id);
  const boundUnsplit = unsplitAdapter.bind(null, txn.id);

  const formInitial: ManualTransactionInitial = {
    transactionId: txn.id,
    type: (txnType ?? 'withdrawal'),
    date: txn.date,
    amount: Number(txn.amount ?? 0),
    bankAccountId: txn.accountId,
    contactId: txn.contactId,
    description: txn.userDescription,
    categoryAccountId: txn.categoryAccountId,
    intent: currentIntent,
    intentTargetId: currentIntentTargetId,
    splits: initialSplitLines.map((l) => ({
      // Pre-fix splits all flowed in the txn's direction; default each
      // line's type to match, then let the user toggle individually.
      type: (txnType ?? 'withdrawal'),
      categoryAccountId: l.categoryAccountId,
      intent: l.intent ?? '',
      intentTargetId: l.intentTargetId,
      amount: l.amount,
      memo: l.memo,
      contactId: l.contactId,
    })),
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href={safeBack} className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to {safeBackLabel}
      </Link>
      <header className="flex items-start justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{txn.bankDescription || txn.description || 'Transaction'}</h1>
            {linkedReceipt && (
              <Link
                href={`/receipts/${linkedReceipt.receiptId}`}
                className="inline-flex items-center rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm hover:from-emerald-600 hover:to-teal-600"
                title={
                  linkedReceipt.receiptVendor
                    ? `Linked to ${linkedReceipt.receiptVendor} receipt — click to open`
                    : 'Linked to a receipt — click to open'
                }
              >
                Linked Receipt
              </Link>
            )}
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {txn.date} · {txn.type ?? '—'} · {txn.verified ? 'Reviewed' : 'Needs review'}
            {txn.journalEntryId && (
              <>
                {' · '}
                <Link href={`/journal-entries/${txn.journalEntryId}`} className="underline">
                  View JE
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-2xl font-semibold tabular-nums">
            {txn.amount != null
              ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(txn.amount)
              : '—'}
          </div>
          <MarkReviewedButton transactionId={id} reviewed={!!txn.verified} />
        </div>
      </header>

      <ManualTransactionForm
        defaultType={txnType ?? 'withdrawal'}
        bankAccounts={bankAccounts.map((a) => ({
          id: a.id,
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          gaapType: a.gaapType,
        }))}
        categoryAccounts={accounts.map((a) => ({
          id: a.id,
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          gaapType: a.gaapType,
        }))}
        contacts={contactList}
        outstandingBills={outstandingBills}
        outstandingInvoices={outstandingInvoices}
        initial={formInitial}
        startInSplitMode={mode === 'split'}
        actions={{
          singleAction: categorizeAdapter,
          splitAction: boundSplit,
          unsplitAction: boundUnsplit,
        }}
        beneficiaries={beneficiaryOptions}
        perBeneficiaryAccountIds={perBeneficiaryAccountIds}
        foodOrClothingAccountIds={foodOrClothingAccountIds}
        initialBeneficiaryId={initialBeneficiaryId}
      />

      {txn.journalEntryId && txn.accountId && (
        <TagsPanel
          journalEntryId={txn.journalEntryId}
          bankAccountId={txn.accountId}
          dimensions={tagDimensions}
        />
      )}
    </div>
  );
}
