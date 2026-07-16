import 'server-only';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  imports,
  importedTransactions,
  transactions,
  journalEntries,
  journalEntryLines,
  generalLedger,
} from '@/db/schema/schema';

export interface DeleteImportResult {
  importId: string;
  deletedTransactions: number;
  deletedJournalEntries: number;
  deletedImportedTransactions: number;
}

/**
 * Delete an import and every record that descends from it:
 *   import → imported_transactions
 *           → transactions (promoted) → journal_entries → journal_entry_lines + general_ledger
 *
 * JEs are collected by querying journal_entries.source_id (not transactions.journal_entry_id)
 * because re-categorization creates reversal + replacement JE chains. transactions.journal_entry_id
 * only points at the latest replacement; the original and its reverser remain with the same
 * source_id and would be left behind otherwise, polluting the GL with orphaned net-zero pairs.
 *
 * Wrapped in a single DB transaction so a partial failure rolls back.
 * FK ordering matters — deepest leaves first.
 */
export async function deleteImportCascade(args: {
  organizationId: string;
  importId: string;
}): Promise<DeleteImportResult> {
  const { organizationId, importId } = args;

  // Verify ownership
  const [importRow] = await db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.organizationId, organizationId)))
    .limit(1);
  if (!importRow) throw new Error('Import not found in this organization');

  return await db.transaction(async (tx) => {
    // 1. Find every transaction promoted from this import
    const promotedTxns = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.organizationId, organizationId), eq(transactions.importId, importId)));

    const txnIds = promotedTxns.map((t) => t.id);

    // 2. Find every JE whose source is one of these transactions. This includes
    //    the original post, any reversers, and any post-recategorization replacements
    //    — all share the same (source_type='transaction', source_id=txn.id).
    const jeRows = txnIds.length
      ? await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.organizationId, organizationId),
              eq(journalEntries.sourceType, 'transaction'),
              inArray(journalEntries.sourceId, txnIds),
            ),
          )
      : [];
    const jeIds = jeRows.map((j) => j.id);

    // 3. Delete GL rows + JE lines for those JEs (FK to journal_entries forces this order)
    if (jeIds.length > 0) {
      await tx.delete(generalLedger).where(inArray(generalLedger.journalEntryId, jeIds));
      await tx.delete(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, jeIds));
    }

    // 4. Delete transactions before journal_entries (transactions.journal_entry_id has FK)
    if (txnIds.length > 0) {
      await tx.delete(transactions).where(inArray(transactions.id, txnIds));
    }

    // 5. Delete the journal entries themselves
    if (jeIds.length > 0) {
      await tx.delete(journalEntries).where(inArray(journalEntries.id, jeIds));
    }

    // 6. Delete imported_transactions for this import
    const importedDel = await tx
      .delete(importedTransactions)
      .where(eq(importedTransactions.importId, importId))
      .returning({ id: importedTransactions.id });

    // 7. Delete the import row itself
    await tx.delete(imports).where(eq(imports.id, importId));

    return {
      importId,
      deletedTransactions: txnIds.length,
      deletedJournalEntries: jeIds.length,
      deletedImportedTransactions: importedDel.length,
    };
  });
}
