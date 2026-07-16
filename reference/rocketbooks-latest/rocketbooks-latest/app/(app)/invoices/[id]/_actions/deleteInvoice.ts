'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and, count } from 'drizzle-orm';
import { db } from '@/db/client';
import { invoices, invoiceLines, payments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';

export interface DeleteInvoiceState {
  error?: string;
}

/**
 * Delete an invoice. Behavior:
 *  - Draft (no JE): straight delete of invoice + lines.
 *  - Posted (has JE): reverse the JE first (creates a reversing entry that
 *    nets the GL back to zero but preserves the audit trail), then delete
 *    the invoice + lines. The original JE row stays in the books.
 *  - Has payments applied: blocked. Caller must un-apply / delete payments
 *    first to avoid orphaning them.
 */
export async function deleteInvoice(
  invoiceId: string,
): Promise<DeleteInvoiceState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [inv] = await db
    .select({
      id: invoices.id,
      journalEntryId: invoices.journalEntryId,
      posted: invoices.posted,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
    .limit(1);
  if (!inv) return { error: 'Invoice not found' };

  // Block delete when there are linked payments — those would point at a
  // dangling invoiceId and break A/R history. Owner must remove payments
  // first.
  const [paymentCount] = await db
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.organizationId, orgId), eq(payments.invoiceId, invoiceId)));
  if ((paymentCount?.n ?? 0) > 0) {
    return {
      error:
        'Cannot delete invoice — payments have been applied to it. Delete those payments first.',
    };
  }

  try {
    await db.transaction(async (tx) => {
      if (inv.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: inv.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal of deleted invoice ${invoiceId.slice(0, 8)}`,
          },
          tx,
        );
      }
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      await tx
        .delete(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)));
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  revalidatePath('/invoices');
  redirect('/invoices');
}
