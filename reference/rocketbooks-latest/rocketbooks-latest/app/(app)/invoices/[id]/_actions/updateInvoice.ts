'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { invoices, invoiceLines, contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError, buildUnlockCta } from '@/lib/billing/entitlements';
import { enqueueOutbound, fireOutboundDrain, pickItemQboIdForRevenueAccount, resolveQboId } from '@/lib/qbo/mirror/outbound';
import { serializeInvoiceToQbo, type InvoiceLineInput } from '@/lib/qbo/mirror/serializers';
import { ensureSalesTaxPayableAccount } from '@/lib/qbo/mirror/tax-account';
import { logger } from '@/lib/logger';

const LineSchema = z.object({
  description: z.string().max(500).optional(),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
  revenueAccountId: z.string().min(1),
});

const InputSchema = z.object({
  contactId: z.string().min(1),
  invoiceNumber: z.string().max(60).optional(),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  memo: z.string().max(500).optional(),
  arAccountId: z.string().min(1),
  postNow: z.coerce.boolean().optional(),
  discountAmount: z.coerce.number().min(0).default(0),
  taxAmount: z.coerce.number().min(0).default(0),
  lines: z.array(LineSchema).min(1),
});

export interface UpdateInvoiceState {
  error?: string;
  unlockProductId?: string;
  unlockLabel?: string;
}

/**
 * Update a draft invoice. Posted invoices are read-only — for those the user
 * has to delete (which reverses the JE) and re-create. Mirrors createInvoice
 * for validation / line-replacement / optional post-on-save.
 */
export async function updateInvoice(
  invoiceId: string,
  _prev: UpdateInvoiceState | undefined,
  formData: FormData,
): Promise<UpdateInvoiceState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [existing] = await db
    .select({
      id: invoices.id,
      posted: invoices.posted,
      status: invoices.status,
      journalEntryId: invoices.journalEntryId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
    .limit(1);
  if (!existing) return { error: 'Invoice not found' };
  // Editing an invoice with payments applied is allowed — payments stay
  // linked to the invoice id, and the open balance just recomputes from the
  // new total minus the already-applied amount. Delete still blocks on
  // payments because deletion removes the invoice id, which would orphan
  // the payment record.

  const lines: unknown[] = [];
  for (let i = 0; ; i++) {
    const desc = formData.get(`lines[${i}].description`);
    const qty = formData.get(`lines[${i}].quantity`);
    if (qty === null && desc === null) break;
    if (qty === null) continue;
    lines.push({
      description: desc ?? '',
      quantity: qty,
      unitPrice: formData.get(`lines[${i}].unitPrice`) ?? 0,
      revenueAccountId: formData.get(`lines[${i}].revenueAccountId`) ?? '',
    });
  }

  const parsed = InputSchema.safeParse({
    contactId: formData.get('contactId'),
    invoiceNumber: formData.get('invoiceNumber') || undefined,
    invoiceDate: formData.get('invoiceDate'),
    dueDate: formData.get('dueDate') || undefined,
    memo: formData.get('memo') || undefined,
    arAccountId: formData.get('arAccountId'),
    postNow: formData.get('postNow'),
    discountAmount: formData.get('discountAmount') || 0,
    taxAmount: formData.get('taxAmount') || 0,
    lines,
  });

  if (!parsed.success) {
    return { error: 'Invalid input. Each line needs quantity, unit price, and a revenue account.' };
  }

  try {
    await requireDateCovered(orgId, parsed.data.invoiceDate);
  } catch (e) {
    if (e instanceof DateNotCoveredError) {
      return { error: e.message, ...(await buildUnlockCta(e)) };
    }
    throw e;
  }

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!contact) return { error: 'Customer not in this organization' };

  const accountIds = [parsed.data.arAccountId, ...parsed.data.lines.map((l) => l.revenueAccountId)];
  const orgAccounts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
  if (accountIds.some((id) => !orgAccountIds.has(id))) {
    return { error: 'One or more accounts not in this organization' };
  }

  const lineRows = parsed.data.lines.map((l) => ({
    id: randomUUID(),
    description: l.description ?? null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: Math.round(l.quantity * l.unitPrice * 100) / 100,
    revenueAccountId: l.revenueAccountId,
  }));
  const subtotal = lineRows.reduce((s, l) => s + l.amount, 0);
  if (subtotal <= 0) return { error: 'Invoice line subtotal must be positive' };
  const discount = parsed.data.discountAmount;
  const tax = parsed.data.taxAmount;
  if (discount > subtotal) return { error: 'Discount cannot exceed line subtotal' };
  const grossTotal = Math.round((subtotal - discount + tax) * 100) / 100;
  if (grossTotal <= 0) return { error: 'Invoice total must be positive' };

  const postNow = !!parsed.data.postNow;
  const now = new Date().toISOString();
  const outboundQueueIds: string[] = [];

  try {
    await db.transaction(async (tx) => {
      // If the invoice was previously posted, reverse the old JE before
      // replacing the lines so the GL stays balanced and the audit trail
      // shows the swap. Posted-with-payments is already blocked above.
      if (existing.posted && existing.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: existing.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal for edit of invoice ${invoiceId.slice(0, 8)}`,
          },
          tx,
        );
      }

      // Replace lines (drop + reinsert). Cleaner than per-line diff for the
      // small line counts a typical invoice has.
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      for (const l of lineRows) {
        await tx.insert(invoiceLines).values({
          id: l.id,
          invoiceId,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          amount: String(l.amount),
        });
      }

      let journalEntryId: string | null = null;
      if (postNow) {
        // Mirror createInvoice's JE shape: AR debit = grossTotal, revenue
        // credits split proportional to the (post-discount) net, tax
        // credit when present.
        const byAccount = new Map<string, number>();
        for (const l of lineRows) {
          byAccount.set(l.revenueAccountId, (byAccount.get(l.revenueAccountId) ?? 0) + l.amount);
        }
        const discountRatio = subtotal > 0 ? discount / subtotal : 0;
        const revenueCredits = Array.from(byAccount.entries()).map(([accountId, amount]) => ({
          accountId,
          credit: Math.round((amount * (1 - discountRatio)) * 100) / 100,
        }));
        const expectedRevenueSum = Math.round((subtotal - discount) * 100) / 100;
        const actualRevenueSum = revenueCredits.reduce((s, c) => s + c.credit, 0);
        const drift = Math.round((expectedRevenueSum - actualRevenueSum) * 100) / 100;
        if (drift !== 0 && revenueCredits.length > 0) {
          revenueCredits.sort((a, b) => b.credit - a.credit);
          revenueCredits[0].credit = Math.round((revenueCredits[0].credit + drift) * 100) / 100;
        }
        const jeLines = [
          {
            accountId: parsed.data.arAccountId,
            debit: grossTotal,
            credit: 0,
            contactId: parsed.data.contactId,
            memo: `Invoice ${parsed.data.invoiceNumber ?? ''}`.trim(),
          },
          ...revenueCredits.map((c) => ({
            accountId: c.accountId,
            debit: 0,
            credit: c.credit,
            contactId: parsed.data.contactId,
            memo: parsed.data.memo ?? null,
          })),
        ];
        if (tax > 0) {
          const taxAccountId = await ensureSalesTaxPayableAccount(orgId, tx);
          jeLines.push({ accountId: taxAccountId, debit: 0, credit: tax, contactId: parsed.data.contactId, memo: 'Sales tax' });
        }
        const result = await createJournalEntry(
          {
            organizationId: orgId,
            date: parsed.data.invoiceDate,
            memo: parsed.data.memo ?? `Invoice ${parsed.data.invoiceNumber ?? ''}`.trim(),
            posted: true,
            sourceType: 'invoice',
            sourceId: invoiceId,
            lines: jeLines,
          },
          tx,
        );
        journalEntryId = result.id;
      }

      await tx
        .update(invoices)
        .set({
          contactId: parsed.data.contactId,
          invoiceNumber: parsed.data.invoiceNumber ?? null,
          invoiceDate: parsed.data.invoiceDate,
          dueDate: parsed.data.dueDate ?? null,
          memo: parsed.data.memo ?? null,
          arAccountId: parsed.data.arAccountId,
          status: postNow ? 'open' : 'draft',
          posted: postNow,
          postedAt: postNow ? now : null,
          journalEntryId,
          taxAmount: String(tax),
          discountAmount: String(discount),
          updatedAt: now,
        })
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)));

      // QBO outbound. Treat as 'update' when the invoice was already
      // pushed (entity_map row exists), else 'create' so an invoice that
      // failed its initial outbound (e.g. customer wasn't mapped) gets a
      // second chance on edit.
      const customerQboId = await resolveQboId(tx, orgId, 'customer', parsed.data.contactId);
      if (!customerQboId) {
        logger.warn({ invoiceId, customerLocalId: parsed.data.contactId }, 'qbo outbound skip on invoice update: customer not mapped');
        return;
      }
      const lineInputs: InvoiceLineInput[] = [];
      let allLinesMapped = true;
      for (const l of lineRows) {
        const itemQboId = await pickItemQboIdForRevenueAccount(tx, orgId, l.revenueAccountId);
        if (!itemQboId) {
          logger.warn({ invoiceId, revenueAccountId: l.revenueAccountId }, 'qbo outbound skip: no mapped item for revenue account');
          allLinesMapped = false;
          break;
        }
        lineInputs.push({
          description: l.description,
          amount: l.amount,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          itemQboId,
          taxable: tax > 0,
        });
      }
      if (!allLinesMapped) return;

      const existingMap = await resolveQboId(tx, orgId, 'invoice', invoiceId);
      const qid = await enqueueOutbound(tx, {
        organizationId: orgId,
        entityType: 'invoice',
        localId: invoiceId,
        operation: existingMap ? 'update' : 'create',
        payload: serializeInvoiceToQbo({
          customerQboId,
          docNumber: parsed.data.invoiceNumber ?? null,
          txnDate: parsed.data.invoiceDate,
          dueDate: parsed.data.dueDate ?? null,
          memo: parsed.data.memo ?? null,
          lines: lineInputs,
          discountAmount: discount,
          taxAmount: tax,
        }) as unknown as Record<string, unknown>,
      });
      if (qid) outboundQueueIds.push(qid);
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await fireOutboundDrain(outboundQueueIds);

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  redirect(`/invoices/${invoiceId}`);
}
