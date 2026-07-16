'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { transactions, contacts, journalEntryLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface UpdateTransactionContactResult {
  ok: boolean;
  error?: string;
}

/**
 * Re-assign the vendor (contact) on a transaction from the beneficiary
 * detail card view. Updates transactions.contactId AND every JE line on
 * the txn's journal entry so the GL stays consistent.
 *
 * Contact is a labeling/grouping field — debits/credits don't change —
 * so this is an in-place update, not a repost. The full edit page still
 * reposts on contact change for parity with category/date/account
 * changes; this action is the lightweight inline path.
 */
export async function updateTransactionContact(args: {
  transactionId: string;
  contactId: string | null;
}): Promise<UpdateTransactionContactResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [txn] = await db
    .select({
      id: transactions.id,
      journalEntryId: transactions.journalEntryId,
    })
    .from(transactions)
    .where(and(eq(transactions.id, args.transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return { ok: false, error: 'Transaction not found' };

  if (args.contactId) {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, args.contactId), eq(contacts.organizationId, orgId)))
      .limit(1);
    if (!c) return { ok: false, error: 'Contact not in this organization' };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(transactions)
      .set({ contactId: args.contactId })
      .where(eq(transactions.id, txn.id));
    if (txn.journalEntryId) {
      await tx
        .update(journalEntryLines)
        .set({ contactId: args.contactId })
        .where(eq(journalEntryLines.journalEntryId, txn.journalEntryId));
    }
  });

  revalidatePath('/trust-beneficiaries');
  revalidatePath(`/transactions/${txn.id}`);
  return { ok: true };
}
