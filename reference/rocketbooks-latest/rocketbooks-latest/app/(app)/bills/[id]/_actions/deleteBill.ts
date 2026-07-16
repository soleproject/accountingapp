'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and, count, desc, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { bills, billLines, journalEntries, payments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { enqueueOutbound, fireOutboundDrain, resolveQboId } from '@/lib/qbo/mirror/outbound';

export interface DeleteBillState {
  error?: string;
}

/**
 * Delete a bill. Mirrors deleteInvoice:
 *  - Draft (no JE): straight delete of bill + lines.
 *  - Posted (has JE): reverse the active JE first, then delete.
 *  - Has payments: blocked. Caller must remove payments first to avoid
 *    orphaning the payment record.
 *
 * The bills table doesn't carry a journalEntryId column — the link is
 * journalEntries.sourceType='bill' / sourceId=billId — so we look it up.
 */
export async function deleteBill(billId: string): Promise<DeleteBillState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [bill] = await db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
    .limit(1);
  if (!bill) return { error: 'Bill not found' };

  const [paymentCount] = await db
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.organizationId, orgId), eq(payments.billId, billId)));
  if ((paymentCount?.n ?? 0) > 0) {
    return {
      error:
        'Cannot delete bill — payments have been applied to it. Delete those payments first.',
    };
  }

  // Find the active (un-reversed) bill JE if any.
  const [activeJe] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.organizationId, orgId),
        eq(journalEntries.sourceType, 'bill'),
        eq(journalEntries.sourceId, billId),
        isNull(journalEntries.reversalOfId),
      ),
    )
    .orderBy(desc(journalEntries.createdAt))
    .limit(1);

  let outboundQueueIds: string[] = [];
  try {
    outboundQueueIds = await db.transaction(async (tx) => {
      if (activeJe) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: activeJe.id,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal of deleted bill ${billId.slice(0, 8)}`,
          },
          tx,
        );
      }
      // Enqueue the QBO delete BEFORE we wipe the local row — the drain
      // worker reads qbo_entity_map to find the QBO id, and the lookup
      // works on the row's localId either way (FK isn't enforced on
      // entity_map). We still resolve up-front for the skip path.
      const billQboId = await resolveQboId(tx, orgId, 'bill', billId);
      let qid: string | null = null;
      if (billQboId) {
        qid = await enqueueOutbound(tx, {
          organizationId: orgId,
          entityType: 'bill',
          localId: billId,
          operation: 'delete',
          // Empty payload: the drain reads Id + SyncToken from
          // entity_map at process time, which is the only data QBO
          // needs for ?operation=delete.
          payload: {},
        });
      }
      await tx.delete(billLines).where(eq(billLines.billId, billId));
      await tx
        .delete(bills)
        .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)));
      return qid ? [qid] : [];
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await fireOutboundDrain(outboundQueueIds);

  revalidatePath('/bills');
  redirect('/bills');
}
