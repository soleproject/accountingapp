'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { bookReviewFindings, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { recordFirmChange } from '@/lib/enterprise/attribution';
import { reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { logger } from '@/lib/logger';

export interface ResolveResult {
  ok: boolean;
  error?: string;
}

function revalidate() {
  revalidatePath('/book-review');
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
}

/**
 * Resolve a duplicate finding by treating one of the two transactions as the
 * duplicate. We REVERSE that transaction's journal entry (removing the
 * double-counted GL impact — the actual harm of a duplicate) rather than
 * deleting the row: a hard delete is FK-unsafe (reconciliation_matches,
 * statement_lines, ai_recommendations all reference transactions.id with no
 * cascade) and deleting history is poor bookkeeping. The transaction stays for
 * the audit trail, marked reviewed with a "[duplicate]" note, and its GL effect
 * nets to zero against the reversal.
 */
export async function resolveDuplicateFinding(args: {
  findingId: string;
  duplicateTransactionId: string;
}): Promise<ResolveResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const [finding] = await db
    .select({
      id: bookReviewFindings.id,
      transactionId: bookReviewFindings.transactionId,
      relatedTransactionId: bookReviewFindings.relatedTransactionId,
    })
    .from(bookReviewFindings)
    .where(
      and(
        eq(bookReviewFindings.id, args.findingId),
        eq(bookReviewFindings.organizationId, orgId),
        eq(bookReviewFindings.kind, 'duplicate'),
        eq(bookReviewFindings.status, 'open'),
      ),
    )
    .limit(1);
  if (!finding) return { ok: false, error: 'Finding not found in this organization' };

  // The chosen duplicate must be one of the pair (defense against tampering).
  if (
    args.duplicateTransactionId !== finding.transactionId &&
    args.duplicateTransactionId !== finding.relatedTransactionId
  ) {
    return { ok: false, error: 'Transaction is not part of this duplicate pair' };
  }

  const [dup] = await db
    .select({
      id: transactions.id,
      journalEntryId: transactions.journalEntryId,
      userDescription: transactions.userDescription,
    })
    .from(transactions)
    .where(and(eq(transactions.id, args.duplicateTransactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!dup) return { ok: false, error: 'Transaction not found in this organization' };

  try {
    await db.transaction(async (tx) => {
      if (dup.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: dup.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal of duplicate transaction ${dup.id.slice(0, 8)}`,
          },
          tx,
        );
      }
      await tx
        .update(transactions)
        .set({
          reviewed: true,
          userDescription: dup.userDescription
            ? `[duplicate] ${dup.userDescription}`
            : '[duplicate]',
        })
        .where(eq(transactions.id, dup.id));

      await tx
        .update(bookReviewFindings)
        .set({
          status: 'resolved',
          resolution: 'merged',
          dismissedAt: new Date().toISOString(),
          dismissedByUserId: userId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bookReviewFindings.id, finding.id));
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { ok: false, error: err.message };
    logger.error(
      { findingId: finding.id, err: err instanceof Error ? err.message : String(err) },
      'resolveDuplicateFinding failed',
    );
    return { ok: false, error: 'Could not resolve the duplicate. Please try again.' };
  }

  await recordFirmChange({ action: 'resolve_finding', orgId, entityType: 'finding', entityId: finding.id, summary: 'Resolved a duplicate finding' });
  revalidate();
  return { ok: true };
}

/** Dismiss a finding as a non-issue (duplicate kept on purpose, or an
 *  integrity finding acknowledged). Org-scoped; idempotent. */
export async function dismissBookFinding(args: {
  findingId: string;
  note?: string;
}): Promise<ResolveResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const result = await db
    .update(bookReviewFindings)
    .set({
      status: 'dismissed',
      resolution: 'kept',
      dismissedAt: new Date().toISOString(),
      dismissedByUserId: userId,
      dismissedNote: args.note?.trim() || null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(bookReviewFindings.id, args.findingId),
        eq(bookReviewFindings.organizationId, orgId),
        eq(bookReviewFindings.status, 'open'),
      ),
    )
    .returning({ id: bookReviewFindings.id });

  if (result.length === 0) return { ok: false, error: 'Finding not found in this organization' };

  await recordFirmChange({ action: 'dismiss_finding', orgId, entityType: 'finding', entityId: args.findingId, summary: 'Dismissed a book-review finding' });
  revalidate();
  return { ok: true };
}
