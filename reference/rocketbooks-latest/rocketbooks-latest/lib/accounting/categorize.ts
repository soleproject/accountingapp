import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, journalEntries } from '@/db/schema/schema';
import { createJournalEntryFromTransaction, repostTransactionJE } from './auto-post';
import { findOrCreateContact } from './ensure-contact';
import { resolveAccount } from './resolve-account';
import { logger } from '@/lib/logger';

/**
 * Result of a single-transaction categorization.
 *
 * `mode: 'posted'`  → the transaction had no JE; we created one (debit/credit
 *                     against the chosen category account) and stamped the
 *                     transaction with categoryAccountId + journalEntryId +
 *                     reviewed=true. This is the "real money moved" path.
 * `mode: 'updated'` → the transaction already had a JE (from a prior
 *                     categorization). We only flipped categoryAccountId and
 *                     marked reviewed=true. No new GL postings.
 */
export type CategorizeResult =
  | {
      ok: true;
      mode: 'posted' | 'updated';
      accountName: string;
      journalEntryId: string | null;
      transaction: {
        id: string;
        date: string | null;
        description: string | null;
        amount: number | null;
        type: string | null;
      };
    }
  | { ok: false; error: string };

/**
 * Categorize a single transaction. Source of truth used by both the UI's
 * bulkCategorize action (in a loop) and the AI's categorize_transaction tool.
 *
 * Org scoping is enforced for both the transaction and the account — a chat
 * tool can't be tricked into categorizing a txn into another org's account by
 * passing crafted ids.
 */
export async function categorizeTransaction(args: {
  organizationId: string;
  transactionId: string;
  categoryAccountId: string;
}): Promise<CategorizeResult> {
  const account = await resolveAccount(args.organizationId, args.categoryAccountId);
  if (!account) return { ok: false, error: 'Category account not in this organization' };
  if (account.resolvedVia !== 'id') {
    logger.info(
      {
        tool: 'categorize_transaction',
        providedAccountId: args.categoryAccountId,
        resolvedVia: account.resolvedVia,
        resolvedToId: account.id,
      },
      'account resolved via fallback',
    );
  }
  const resolvedCategoryAccountId = account.id;

  const [txn] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, args.transactionId),
        eq(transactions.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!txn) {
    // Forensic log: gpt-4o-mini sometimes hallucinates transaction UUIDs in
    // multi-turn flows. categorize_contact_uncategorized eliminates that path,
    // but the singular categorize_transaction (heterogeneous fallback) still
    // takes a transactionId UUID directly — see TODO B6 in realtime-tool-dispatch.
    logger.warn(
      { transactionId: args.transactionId, categoryAccountId: args.categoryAccountId },
      'transaction not found',
    );
    return { ok: false, error: 'Transaction not in this organization' };
  }

  // Resolve the EFFECTIVE existing journal entry for this transaction:
  //   - the stamp, when it points at a JE that really exists;
  //   - otherwise an orphaned, unreversed posting still sitting in the GL for
  //     this txn (the repost bug left these) — ADOPT it instead of posting a
  //     SECOND entry. Blindly posting fresh here is what double-posted ~1k txns;
  //   - if neither exists, the txn is genuinely unposted → create a fresh JE.
  let effectiveJeId: string | null = null;
  let adoptedOrphan = false;
  if (txn.journalEntryId) {
    const [je] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.id, txn.journalEntryId))
      .limit(1);
    if (je) effectiveJeId = je.id;
  }
  if (!effectiveJeId) {
    const [orphan] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.organizationId, args.organizationId),
          eq(journalEntries.sourceType, 'transaction'),
          eq(journalEntries.sourceId, txn.id),
          // Exclude reversers (reversal_of_id set) — they're also source='transaction'
          // but are contra entries, not the live posting we want to adopt.
          isNull(journalEntries.reversalOfId),
          sql`exists (select 1 from journal_entry_lines jl where jl.journal_entry_id = ${journalEntries.id})`,
          sql`not exists (select 1 from journal_entries rev where rev.reversal_of_id = ${journalEntries.id})`,
        ),
      )
      .orderBy(desc(journalEntries.createdAt))
      .limit(1);
    if (orphan) {
      effectiveJeId = orphan.id;
      adoptedOrphan = true;
      logger.warn(
        { txnId: txn.id, adoptedOrphanJe: orphan.id, danglingStamp: txn.journalEntryId },
        'categorizeTransaction: re-linking an orphaned JE instead of posting a duplicate',
      );
    } else if (txn.journalEntryId) {
      logger.warn(
        { txnId: txn.id, danglingJournalEntryId: txn.journalEntryId },
        'categorizeTransaction: stamp points at a missing JE and no orphan exists — posting fresh',
      );
    }
  }

  // Existing-posting path — effectiveJeId is the real stamp or an adopted orphan.
  //   1. Real stamp + category unchanged → just mark reviewed; JE stays.
  //   2. Otherwise reverse the existing/adopted JE and post a fresh one against
  //      the chosen category, then re-link. Net effect is ONE live posting —
  //      never a duplicate, even when adopting an orphan.
  if (effectiveJeId) {
    if (!adoptedOrphan && txn.journalEntryId === effectiveJeId && txn.categoryAccountId === resolvedCategoryAccountId) {
      await db
        .update(transactions)
        .set({ reviewed: true })
        .where(eq(transactions.id, txn.id));
      return {
        ok: true,
        mode: 'updated',
        accountName: account.accountName,
        journalEntryId: effectiveJeId,
        transaction: {
          id: txn.id,
          date: txn.date,
          description: txn.description ?? txn.bankDescription,
          amount: txn.amount,
          type: txn.type,
        },
      };
    }

    if (txn.amount == null || !txn.type || !txn.accountId) {
      return {
        ok: false,
        error: 'Cannot repost JE: transaction is missing amount, type, or bank account.',
      };
    }

    try {
      const reposted = await repostTransactionJE({
        txn: {
          id: txn.id,
          organizationId: args.organizationId,
          date: txn.date,
          type: txn.type,
          amount: txn.amount,
          accountId: txn.accountId,
          categoryAccountId: resolvedCategoryAccountId,
          contactId: txn.contactId,
          bankDescription: txn.bankDescription,
          userDescription: txn.userDescription,
        },
        existingJournalEntryId: effectiveJeId,
      });
      await db
        .update(transactions)
        .set({
          categoryAccountId: resolvedCategoryAccountId,
          journalEntryId: reposted.replacementId,
          reviewed: true,
        })
        .where(eq(transactions.id, txn.id));

      if (txn.accountId && reposted.replacementId) {
        const { maybeAutoTagFromMemory } = await import('./tag-from-memory');
        await maybeAutoTagFromMemory({
          organizationId: args.organizationId,
          transactionId: txn.id,
          journalEntryId: reposted.replacementId,
          bankAccountId: txn.accountId,
          categoryAccountId: resolvedCategoryAccountId,
          contactId: txn.contactId,
          amount: Math.abs(Number(txn.amount)),
          description: txn.bankDescription ?? txn.description,
        });
      }

      return {
        ok: true,
        mode: 'updated',
        accountName: account.accountName,
        journalEntryId: reposted.replacementId,
        transaction: {
          id: txn.id,
          date: txn.date,
          description: txn.description ?? txn.bankDescription,
          amount: txn.amount,
          type: txn.type,
        },
      };
    } catch (err) {
      logger.warn(
        { txnId: txn.id, err: err instanceof Error ? err.message : err },
        'categorizeTransaction: JE repost failed',
      );
      return { ok: false, error: err instanceof Error ? err.message : 'JE repost failed' };
    }
  }

  if (txn.amount == null || !txn.type || !txn.accountId) {
    return {
      ok: false,
      error: 'Transaction is missing required fields for posting (amount, type, or bank account)',
    };
  }

  try {
    let resolvedContactId = txn.contactId;
    if (!resolvedContactId) {
      resolvedContactId = await findOrCreateContact({
        organizationId: args.organizationId,
        merchantName: txn.bankDescription ?? txn.description,
        type: txn.type,
      });
    }
    const jeId = await createJournalEntryFromTransaction({
      id: txn.id,
      organizationId: args.organizationId,
      date: txn.date,
      type: txn.type,
      amount: txn.amount,
      accountId: txn.accountId,
      categoryAccountId: resolvedCategoryAccountId,
      contactId: resolvedContactId,
      bankDescription: txn.bankDescription,
      userDescription: txn.userDescription,
    });
    await db
      .update(transactions)
      .set({
        categoryAccountId: resolvedCategoryAccountId,
        contactId: resolvedContactId,
        journalEntryId: jeId,
        reviewed: true,
      })
      .where(eq(transactions.id, txn.id));

    // Auto-tag from prior history (rental property / fixed asset).
    // Best-effort — failures logged + swallowed inside the helper.
    if (txn.accountId) {
      const { maybeAutoTagFromMemory } = await import('./tag-from-memory');
      await maybeAutoTagFromMemory({
        organizationId: args.organizationId,
        transactionId: txn.id,
        journalEntryId: jeId,
        bankAccountId: txn.accountId,
        categoryAccountId: resolvedCategoryAccountId,
        contactId: resolvedContactId,
        amount: Math.abs(Number(txn.amount)),
        description: txn.bankDescription ?? txn.description,
      });
    }

    return {
      ok: true,
      mode: 'posted',
      accountName: account.accountName,
      journalEntryId: jeId,
      transaction: {
        id: txn.id,
        date: txn.date,
        description: txn.description ?? txn.bankDescription,
        amount: txn.amount,
        type: txn.type,
      },
    };
  } catch (err) {
    logger.warn(
      { txnId: txn.id, err: err instanceof Error ? err.message : err },
      'categorizeTransaction failed',
    );
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to post' };
  }
}
