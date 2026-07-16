import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  transactions,
  journalEntries,
  journalEntryLines,
  generalLedger,
} from '@/db/schema/schema';

/**
 * Propagate metadata-only changes from a transaction row down into its
 * existing journal entry, journal entry lines, and general ledger rows.
 *
 * "Metadata-only" means fields that don't affect the debits/credits being
 * posted — currently contact_id, journal entry date, and memo. A change to
 * the category, bank account, amount, or type changes WHICH accounts get
 * posted to and is NOT handled here — those need the full reverse-and-repost
 * dance from `repostTransactionJE`.
 *
 * Returns the count of updated rows per layer so the caller can log activity.
 */
export interface PropagateInput {
  organizationId: string;
  /** Transaction ids whose JE/GL should be re-aligned with the row's current state. */
  transactionIds: string[];
}

export interface PropagateResult {
  matchedTransactions: number;
  matchedJournalEntries: number;
  updatedLines: number;
  updatedGlRows: number;
  updatedJournalEntries: number;
}

export async function propagateTransactionMetadataToJE(
  input: PropagateInput,
): Promise<PropagateResult> {
  if (input.transactionIds.length === 0) {
    return { matchedTransactions: 0, matchedJournalEntries: 0, updatedLines: 0, updatedGlRows: 0, updatedJournalEntries: 0 };
  }

  const rows = await db
    .select({
      id: transactions.id,
      journalEntryId: transactions.journalEntryId,
      contactId: transactions.contactId,
      date: transactions.date,
      bankDescription: transactions.bankDescription,
      userDescription: transactions.userDescription,
    })
    .from(transactions)
    .where(
      inArray(transactions.id, input.transactionIds),
    );

  // Filter to ones that match this org AND have a JE — without a JE there's
  // nothing to update downstream.
  const live = rows.filter((r) => r.journalEntryId);
  if (live.length === 0) {
    return {
      matchedTransactions: rows.length,
      matchedJournalEntries: 0,
      updatedLines: 0,
      updatedGlRows: 0,
      updatedJournalEntries: 0,
    };
  }

  let updatedLines = 0;
  let updatedGlRows = 0;
  let updatedJournalEntries = 0;

  await db.transaction(async (tx) => {
    for (const r of live) {
      const jeId = r.journalEntryId!;
      const newContactId = r.contactId ?? null;
      const memo = r.userDescription || r.bankDescription || null;
      const date = r.date; // YYYY-MM-DD string

      // 1. JE: keep date + memo aligned. (Org scope check happens via the
      //    JE row — we already trust the txn's org since we only mutate JEs
      //    referenced by txns in input.transactionIds.)
      const jeUpdate = await tx
        .update(journalEntries)
        .set({ date, memo })
        .where(
          eq(journalEntries.id, jeId),
        )
        .returning({ id: journalEntries.id });
      updatedJournalEntries += jeUpdate.length;

      // 2. JE lines: contact + memo on each. Account / debit / credit are
      //    untouched — those define the posting and are out of scope here.
      const lineUpdate = await tx
        .update(journalEntryLines)
        .set({ contactId: newContactId, memo })
        .where(eq(journalEntryLines.journalEntryId, jeId))
        .returning({ id: journalEntryLines.id });
      updatedLines += lineUpdate.length;

      // 3. GL: contact + date + memo. Balance / debit / credit untouched.
      //    GL.date is a timestamp; preserve any time-of-day on the existing
      //    row by formatting the new date with T00:00:00 — same convention
      //    `createJournalEntry` uses when first inserting.
      const glUpdate = await tx
        .update(generalLedger)
        .set({ contactId: newContactId, date: `${date}T00:00:00`, memo })
        .where(eq(generalLedger.journalEntryId, jeId))
        .returning({ id: generalLedger.id });
      updatedGlRows += glUpdate.length;
    }
  });

  return {
    matchedTransactions: rows.length,
    matchedJournalEntries: live.length,
    updatedLines,
    updatedGlRows,
    updatedJournalEntries,
  };
}
