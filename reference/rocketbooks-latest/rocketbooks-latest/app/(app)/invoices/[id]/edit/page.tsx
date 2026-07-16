import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts, invoices, invoiceLines, journalEntryLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { InvoiceForm, type InvoiceFormInitial } from '../../_components/InvoiceForm';
import { updateInvoice } from '../_actions/updateInvoice';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const AR_TYPES = ['asset', 'current_asset'];

interface PageProps { params: Promise<{ id: string }>; }

export default async function EditInvoicePage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  const [inv] = await db
    .select({
      id: invoices.id,
      contactId: invoices.contactId,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      memo: invoices.memo,
      arAccountId: invoices.arAccountId,
      posted: invoices.posted,
      journalEntryId: invoices.journalEntryId,
      taxAmount: invoices.taxAmount,
      discountAmount: invoices.discountAmount,
    })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId)))
    .limit(1);
  if (!inv) notFound();

  const lineRows = await db
    .select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      // Reverse-look up the original revenue account from the linked JE if
      // the invoice was previously posted-then-unposted. Drafts have no JE,
      // so we fall back to empty and let the user re-pick.
      revenueAccountId: sql<string | null>`(
        SELECT account_id FROM ${journalEntryLines}
        WHERE journal_entry_id = ${inv.journalEntryId}
          AND credit > 0
        LIMIT 1
      )`,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(asc(invoiceLines.id));

  const [contactList, accounts] = await Promise.all([
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

  // Bind the invoice id into the update action so the form sees the same
  // (prev, formData) signature as createInvoice.
  const boundUpdate = updateInvoice.bind(null, id);

  const initial: InvoiceFormInitial = {
    contactId: inv.contactId,
    invoiceNumber: inv.invoiceNumber ?? '',
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate ?? '',
    memo: inv.memo ?? '',
    arAccountId: inv.arAccountId ?? (arFallback[0]?.id ?? ''),
    // Default the postNow box to whatever the invoice's current state is,
    // so editing a posted invoice re-posts on save (most common intent).
    postNow: !!inv.posted,
    discountAmount: Number(inv.discountAmount) > 0 ? String(inv.discountAmount) : '',
    taxAmount: Number(inv.taxAmount) > 0 ? String(inv.taxAmount) : '',
    lines: lineRows.map((l) => ({
      description: l.description ?? '',
      quantity: String(l.quantity ?? '1'),
      unitPrice: String(l.unitPrice ?? '0'),
      revenueAccountId: l.revenueAccountId ?? '',
    })),
  };

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/invoices/${id}`} className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to invoice
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Edit invoice</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {inv.posted
            ? 'Saving will reverse the existing journal entry and post a new one.'
            : 'Draft invoice. Saving with the post box checked will create a journal entry.'}
        </p>
      </header>
      <InvoiceForm
        contacts={contactList}
        revenueAccounts={revenueAccounts}
        arAccounts={arFallback}
        action={boundUpdate}
        initial={initial}
        submitDraftLabel="Save changes"
        submitPostLabel="Save & Post"
      />
    </div>
  );
}
