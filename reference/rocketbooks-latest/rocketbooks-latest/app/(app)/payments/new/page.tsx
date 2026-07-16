import { eq, asc, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts, invoices, bills } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { PaymentForm } from '../_components/PaymentForm';

export default async function NewPaymentPage() {
  const orgId = await getCurrentOrgId();

  const [contactList, accounts, openInvoices, openBills] = await Promise.all([
    db.select({ id: contacts.id, name: contacts.contactName }).from(contacts).where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true))).orderBy(asc(contacts.contactName)),
    db.select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType }).from(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true))).orderBy(asc(chartOfAccounts.accountNumber)),
    db.select({ id: invoices.id, number: invoices.invoiceNumber, date: invoices.invoiceDate }).from(invoices).where(and(eq(invoices.organizationId, orgId), eq(invoices.posted, true))).orderBy(desc(invoices.invoiceDate)).limit(200),
    db.select({ id: bills.id, number: bills.billNumber, date: bills.billDate }).from(bills).where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted'))).orderBy(desc(bills.billDate)).limit(200),
  ]);

  const bankAccounts = accounts.filter((a) => {
    const t = (a.gaapType ?? '').toLowerCase();
    const name = a.accountName.toLowerCase();
    return ['asset', 'current_asset'].includes(t) && ['cash', 'checking', 'savings', 'bank'].some((kw) => name.includes(kw));
  });
  const allAssets = accounts.filter((a) => ['asset', 'current_asset'].includes((a.gaapType ?? '').toLowerCase()));
  const arAccounts = accounts.filter((a) => {
    const name = a.accountName.toLowerCase();
    return ['asset', 'current_asset'].includes((a.gaapType ?? '').toLowerCase()) && (name.includes('receivable') || name.includes('a/r'));
  });
  const apAccounts = accounts.filter((a) => {
    const name = a.accountName.toLowerCase();
    return ['liability', 'current_liability'].includes((a.gaapType ?? '').toLowerCase()) && (name.includes('payable') || name.includes('a/p'));
  });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New payment</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Receive customer payment or send vendor payment — auto-posts JE</p>
      </header>
      <PaymentForm
        contacts={contactList}
        bankAccounts={bankAccounts.length > 0 ? bankAccounts : allAssets}
        arAccounts={arAccounts}
        apAccounts={apAccounts}
        invoices={openInvoices}
        bills={openBills}
      />
    </div>
  );
}
