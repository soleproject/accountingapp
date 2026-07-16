'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  contacts,
  transactions,
  journalEntryLines,
  generalLedger,
  aiRecommendations,
  contactProfiles,
  bills,
  billPayments,
  invoices,
  invoicePayments,
  receipts,
  transactionSplits,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const Schema = z.object({
  targetId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1).max(50),
});

export interface MergeContactsState {
  ok?: boolean;
  error?: string;
  /** Counts of references rewired per table, useful for the success toast. */
  rewired?: Record<string, number>;
  /** Number of source contacts deleted at the end. */
  deletedContacts?: number;
}

/**
 * Merge one or more source contacts INTO a target contact (the survivor).
 * Every cross-table reference to a source is rewired to point at the target,
 * then the source contact rows are deleted. Wrapped in a single DB
 * transaction so a partial failure rolls everything back.
 *
 * Tables rewired:
 *   - ai_recommendations.contact_id, current_contact_id, suggested_contact_id
 *   - contact_profiles.contact_id (special-cased: UNIQUE constraint)
 *   - bills.contact_id
 *   - bill_payments.contact_id
 *   - invoices.contact_id
 *   - invoice_payments.contact_id
 *   - general_ledger.contact_id
 *   - journal_entry_lines.contact_id
 *   - receipts.contact_id
 *   - transaction_splits.contact_id
 *   - transactions.contact_id
 *
 * The contact_id stored on existing JE lines + GL rows is rewired in place
 * — debits/credits don't change, so we don't repost JEs. Reports keyed off
 * contact_id stay consistent post-merge.
 *
 * The target's name/email/phone/tags survive. Source data on those fields
 * is gone after the merge — if you wanted to keep something from a source,
 * edit the target before merging.
 */
export async function mergeContacts(
  _prev: MergeContactsState | undefined,
  formData: FormData,
): Promise<MergeContactsState> {
  const orgId = await getCurrentOrgId();
  const parsed = Schema.safeParse({
    targetId: formData.get('targetId'),
    sourceIds: formData.getAll('sourceIds').map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: 'Pick a target and at least one source contact.' };
  const { targetId } = parsed.data;
  const filteredSources = parsed.data.sourceIds.filter((id) => id !== targetId);
  if (filteredSources.length === 0) {
    return { error: 'No source contacts to merge after excluding the target.' };
  }

  // Verify every contact involved belongs to this org. Single query.
  const allIds = [targetId, ...filteredSources];
  const owned = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, allIds)));
  if (owned.length !== allIds.length) {
    return { error: 'One or more contacts do not belong to this organization.' };
  }

  const rewired: Record<string, number> = {};
  let deletedContacts = 0;

  await db.transaction(async (tx) => {
    // ai_recommendations has three contact-id columns; rewire each separately.
    rewired['ai_recommendations.contact_id'] = (
      await tx
        .update(aiRecommendations)
        .set({ contactId: targetId })
        .where(inArray(aiRecommendations.contactId, filteredSources))
    ).count ?? 0;
    rewired['ai_recommendations.current_contact_id'] = (
      await tx
        .update(aiRecommendations)
        .set({ currentContactId: targetId })
        .where(inArray(aiRecommendations.currentContactId, filteredSources))
    ).count ?? 0;
    rewired['ai_recommendations.suggested_contact_id'] = (
      await tx
        .update(aiRecommendations)
        .set({ suggestedContactId: targetId })
        .where(inArray(aiRecommendations.suggestedContactId, filteredSources))
    ).count ?? 0;

    // contact_profiles has a UNIQUE constraint on contact_id. Two cases:
    //   1. Target already has a profile → drop every source profile.
    //   2. Target has no profile → keep the first source profile and rewire
    //      it to the target; drop the rest.
    const [targetProfile] = await tx
      .select({ id: contactProfiles.id })
      .from(contactProfiles)
      .where(eq(contactProfiles.contactId, targetId))
      .limit(1);
    if (targetProfile) {
      rewired['contact_profiles.deleted'] = (
        await tx.delete(contactProfiles).where(inArray(contactProfiles.contactId, filteredSources))
      ).count ?? 0;
    } else {
      const sourceProfiles = await tx
        .select({ id: contactProfiles.id })
        .from(contactProfiles)
        .where(inArray(contactProfiles.contactId, filteredSources));
      if (sourceProfiles.length > 0) {
        const [keep, ...rest] = sourceProfiles;
        await tx.update(contactProfiles).set({ contactId: targetId }).where(eq(contactProfiles.id, keep.id));
        rewired['contact_profiles.rewired'] = 1;
        if (rest.length > 0) {
          rewired['contact_profiles.deleted'] = (
            await tx.delete(contactProfiles).where(inArray(contactProfiles.id, rest.map((p) => p.id)))
          ).count ?? 0;
        }
      }
    }

    // Straightforward rewires for the remaining tables.
    rewired['bills'] = (
      await tx.update(bills).set({ contactId: targetId }).where(inArray(bills.contactId, filteredSources))
    ).count ?? 0;
    rewired['bill_payments'] = (
      await tx.update(billPayments).set({ contactId: targetId }).where(inArray(billPayments.contactId, filteredSources))
    ).count ?? 0;
    rewired['invoices'] = (
      await tx.update(invoices).set({ contactId: targetId }).where(inArray(invoices.contactId, filteredSources))
    ).count ?? 0;
    rewired['invoice_payments'] = (
      await tx.update(invoicePayments).set({ contactId: targetId }).where(inArray(invoicePayments.contactId, filteredSources))
    ).count ?? 0;
    rewired['general_ledger'] = (
      await tx.update(generalLedger).set({ contactId: targetId }).where(inArray(generalLedger.contactId, filteredSources))
    ).count ?? 0;
    rewired['journal_entry_lines'] = (
      await tx.update(journalEntryLines).set({ contactId: targetId }).where(inArray(journalEntryLines.contactId, filteredSources))
    ).count ?? 0;
    rewired['receipts'] = (
      await tx.update(receipts).set({ contactId: targetId }).where(inArray(receipts.contactId, filteredSources))
    ).count ?? 0;
    rewired['transaction_splits'] = (
      await tx.update(transactionSplits).set({ contactId: targetId }).where(inArray(transactionSplits.contactId, filteredSources))
    ).count ?? 0;
    rewired['transactions'] = (
      await tx.update(transactions).set({ contactId: targetId }).where(
        and(eq(transactions.organizationId, orgId), inArray(transactions.contactId, filteredSources)),
      )
    ).count ?? 0;

    // Finally, delete the source contacts. After the rewires above there
    // should be no FK references left, so DELETE succeeds. If something
    // does block, the transaction rolls back the rewires too.
    deletedContacts = (
      await tx
        .delete(contacts)
        .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, filteredSources)))
    ).count ?? 0;
  });

  revalidatePath('/contacts');
  revalidatePath('/transactions');
  return { ok: true, rewired, deletedContacts };
}
