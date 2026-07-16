'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { receiptMatchSuggestions, receiptMatchApplications } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { applyReceiptMatch, ApplyMatchError } from '@/lib/receipts/apply-match';
import { undoReceiptMatch as undoReceiptMatchImpl, UndoMatchError } from '@/lib/receipts/undo-match';
import { logger } from '@/lib/logger';

export interface ReviewMatchState {
  error?: string;
}

/**
 * Dismiss a pending suggestion. status='dismissed' takes it out of the
 * action-cards stream and the receipt-detail matches panel for good —
 * the matcher's ON CONFLICT clause leaves status alone on re-runs, so
 * dismissed suggestions stay dismissed even after the matcher revisits
 * them (e.g. backfill).
 */
export async function dismissReceiptMatch(suggestionId: string): Promise<ReviewMatchState | undefined> {
  const orgId = await getCurrentOrgId();
  const [row] = await db
    .select({ id: receiptMatchSuggestions.id, receiptId: receiptMatchSuggestions.receiptId })
    .from(receiptMatchSuggestions)
    .where(
      and(
        eq(receiptMatchSuggestions.id, suggestionId),
        eq(receiptMatchSuggestions.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return { error: 'Suggestion not found' };

  await db
    .update(receiptMatchSuggestions)
    .set({ status: 'dismissed', updatedAt: new Date().toISOString() })
    .where(eq(receiptMatchSuggestions.id, suggestionId));

  logger.info({ suggestionId, receiptId: row.receiptId, status: 'dismissed' }, 'receipt match suggestion dismissed');
  revalidatePath(`/receipts/${row.receiptId}`);
  revalidatePath('/transactions');
  revalidatePath('/ai-chat');
  return undefined;
}

/**
 * Accept a pending suggestion. Runs the full applyReceiptMatch flow —
 * reverses the txn's current JE, builds receipt-match splits + a new
 * collapsed JE, links the receipt to the txn, flips this suggestion to
 * 'auto_applied' (it's user-driven now, but the card UX is the same).
 *
 * Works equally well for a never-applied suggestion and for one that
 * went auto-apply → undo → user clicked Accept to re-apply. apply
 * only requires status='pending', and undoReceiptMatch leaves it there.
 */
export async function acceptReceiptMatch(suggestionId: string): Promise<ReviewMatchState | undefined> {
  const orgId = await getCurrentOrgId();
  const [row] = await db
    .select({
      id: receiptMatchSuggestions.id,
      receiptId: receiptMatchSuggestions.receiptId,
      transactionId: receiptMatchSuggestions.transactionId,
      status: receiptMatchSuggestions.status,
    })
    .from(receiptMatchSuggestions)
    .where(
      and(
        eq(receiptMatchSuggestions.id, suggestionId),
        eq(receiptMatchSuggestions.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return { error: 'Suggestion not found' };
  if (row.status !== 'pending') return { error: `Cannot accept a ${row.status} match` };

  try {
    const result = await applyReceiptMatch({ organizationId: orgId, suggestionId });
    logger.info({ suggestionId, receiptId: row.receiptId, applicationId: result.applicationId }, 'receipt match accepted + applied');
  } catch (err) {
    if (err instanceof ApplyMatchError) return { error: err.message };
    throw err;
  }

  revalidatePath(`/receipts/${row.receiptId}`);
  revalidatePath('/receipts');
  revalidatePath('/transactions');
  revalidatePath(`/transactions/${row.transactionId}`);
  revalidatePath('/ai-chat');
  return undefined;
}

/**
 * "Verify" an auto-applied match. The user is confirming the auto-apply
 * looked right. Just records that confirmation by flipping the
 * suggestion to 'verified' so it stops showing up as needing attention.
 */
export async function verifyReceiptMatch(suggestionId: string): Promise<ReviewMatchState | undefined> {
  const orgId = await getCurrentOrgId();
  const [row] = await db
    .select({ id: receiptMatchSuggestions.id, receiptId: receiptMatchSuggestions.receiptId, status: receiptMatchSuggestions.status })
    .from(receiptMatchSuggestions)
    .where(
      and(
        eq(receiptMatchSuggestions.id, suggestionId),
        eq(receiptMatchSuggestions.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return { error: 'Suggestion not found' };
  if (row.status !== 'auto_applied') return { error: `Cannot verify a ${row.status} match` };

  await db
    .update(receiptMatchSuggestions)
    .set({ status: 'verified', updatedAt: new Date().toISOString() })
    .where(eq(receiptMatchSuggestions.id, suggestionId));

  logger.info({ suggestionId, receiptId: row.receiptId }, 'receipt match verified');
  revalidatePath(`/receipts/${row.receiptId}`);
  revalidatePath('/ai-chat');
  return undefined;
}

/**
 * Undo an auto-applied match. Reverses the JE we created, drops the
 * splits we wrote, restores the receipt + transaction to their
 * pre-apply state, and flips the suggestion back to 'pending' so the
 * user can re-review on /ai-chat if they want.
 */
export async function undoReceiptMatch(applicationId: string): Promise<ReviewMatchState | undefined> {
  const orgId = await getCurrentOrgId();
  const [app] = await db
    .select({
      id: receiptMatchApplications.id,
      receiptId: receiptMatchApplications.receiptId,
      transactionId: receiptMatchApplications.transactionId,
    })
    .from(receiptMatchApplications)
    .where(
      and(
        eq(receiptMatchApplications.id, applicationId),
        eq(receiptMatchApplications.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!app) return { error: 'Application not found' };

  try {
    await undoReceiptMatchImpl({ organizationId: orgId, applicationId });
  } catch (err) {
    if (err instanceof UndoMatchError) return { error: err.message };
    throw err;
  }

  // Undo touches the transaction's contact, JE, category — the Linked
  // Receipt pill and Walmart contact column on /transactions are both
  // derived from those, so the list + detail pages need to drop their
  // RSC cache here too. Forgetting this leaves stale pills hanging
  // around after a successful undo.
  revalidatePath(`/receipts/${app.receiptId}`);
  revalidatePath('/receipts');
  revalidatePath('/transactions');
  revalidatePath(`/transactions/${app.transactionId}`);
  revalidatePath('/ai-chat');
  return undefined;
}
