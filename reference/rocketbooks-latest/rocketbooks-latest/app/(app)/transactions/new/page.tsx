import Link from 'next/link';
import { eq, asc, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts, trustBeneficiaries } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { isIncapacitatedAsOf } from '@/lib/accounting/trust-reroute';
import { ManualTransactionForm, type BeneficiaryOption } from './_components/ManualTransactionForm';

interface PageProps {
  searchParams: Promise<{ type?: string }>;
}

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

export default async function NewTransactionPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { type: typeParam } = await searchParams;
  const type: 'deposit' | 'withdrawal' = typeParam === 'withdrawal' ? 'withdrawal' : 'deposit';

  const [accounts, contactList, outstandingBills, outstandingInvoices, trustEnabled] = await Promise.all([
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        accountType: chartOfAccounts.accountType,
        detailType: chartOfAccounts.detailType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.contactName)),
    getOutstandingBills(orgId),
    getOutstandingInvoices(orgId),
    getOrgFeature(orgId, 'beneficial_trust'),
  ]);

  const bankAccounts = accounts.filter((a) => a.accountType === 'bank');
  // Per-line Type on splits means a single line can hit any account, so
  // the picker now sees the whole CoA (CategorySelect groups by gaap).
  const categoryAccounts = accounts;

  let beneficiaryOptions: BeneficiaryOption[] = [];
  let perBeneficiaryAccountIds: string[] = [];
  let foodOrClothingAccountIds: string[] = [];
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

    // No txn yet on create — qualify against today using the as-of helper
    // so an incapacitation date set for the future doesn't grant a current
    // pass.
    const asOf = new Date().toISOString().slice(0, 10);
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
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/transactions" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to transactions
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">
          {type === 'deposit' ? 'Add deposit' : 'Add withdrawal'}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {type === 'deposit'
            ? 'Cash coming in. Posts a JE: debit bank, credit category.'
            : 'Cash going out. Posts a JE: debit category, credit bank.'}
        </p>
      </header>
      <ManualTransactionForm
        defaultType={type}
        bankAccounts={bankAccounts}
        categoryAccounts={categoryAccounts}
        contacts={contactList}
        outstandingBills={outstandingBills.map((b) => ({
          id: b.id,
          billNumber: b.billNumber,
          vendorName: b.vendorName,
          contactId: b.contactId,
          balance: b.balance,
        }))}
        outstandingInvoices={outstandingInvoices.map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          customerName: i.customerName,
          contactId: i.contactId,
          balance: i.balance,
        }))}
        beneficiaries={beneficiaryOptions}
        perBeneficiaryAccountIds={perBeneficiaryAccountIds}
        foodOrClothingAccountIds={foodOrClothingAccountIds}
      />
    </div>
  );
}
