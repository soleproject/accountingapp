import { randomUUID } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  transactions,
  receipts,
  receiptMatchSuggestions,
  receiptMatchApplications,
} from '@/db/schema/schema';
import { applyReceiptMatch, ApplyMatchError } from '@/lib/receipts/apply-match';
import { logger } from '@/lib/logger';

const AUTO_APPLY_MIN_CONFIDENCE = 0.9;

/**
 * Mirror of findTransactionMatches, keyed off a freshly-created or
 * updated transaction. Looks for DRAFT receipts (posted = false) in
 * the same org that match this transaction exactly:
 *
 *   - |transactions.amount| === receipts.totalAmount
 *   - transactions.date === receipts.receiptDate (date portion only —
 *     Veryfi often returns a timestamp).
 *   - receipts.posted = false (only draft / unmatched).
 *
 * For each match, upserts a pending suggestion at confidence 1.0 (vendor
 * agreement) / 0.95 (no vendor agreement) — both above the 0.9
 * auto-apply bar.
 *
 * If exactly ONE candidate receipt matches and it isn't already linked
 * to another transaction (no active receipt_match_applications row),
 * auto-apply fires immediately. Multiple-candidate ambiguity stays as
 * suggestions for the user to disambiguate via the AI-chat card.
 *
 * Errors are caught + logged so the caller's transaction insert never
 * fails because of a matcher hiccup. Returns the number of suggestions
 * persisted.
 */
export async function findReceiptMatchesForTransaction(input: {
  transactionId: string;
  organizationId: string;
  actorUserId?: string | null;
}): Promise<number> {
  const [t] = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      contactId: transactions.contactId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, input.transactionId),
        eq(transactions.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!t || t.amount == null || !t.date) {
    return 0;
  }

  const absAmount = Math.abs(t.amount);
  const txnDayOnly = t.date.slice(0, 10);

  const candidates = await db
    .select({
      id: receipts.id,
      total: receipts.totalAmount,
      date: receipts.receiptDate,
      contactId: receipts.contactId,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, input.organizationId),
        eq(receipts.posted, false),
        sql`${receipts.totalAmount} = ${absAmount}`,
        sql`SUBSTR(${receipts.receiptDate}, 1, 10) = ${txnDayOnly}`,
      ),
    );
  if (candidates.length === 0) {
    return 0;
  }

  // Upsert one suggestion per candidate receipt. confidence is 1.0
  // when the vendor agrees, 0.95 otherwise — both above the auto-apply
  // threshold; vendor agreement is just a tie-breaker for ranking.
  const now = new Date().toISOString();
  const values = candidates.map((r) => {
    const vendorMatch = !!(r.contactId && t.contactId && r.contactId === t.contactId);
    return {
      id: randomUUID(),
      organizationId: input.organizationId,
      receiptId: r.id,
      transactionId: t.id,
      confidence: vendorMatch ? '1.000' : '0.950',
      amountDiff: '0.00',
      dateDiffDays: 0,
      vendorMatch,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  });
  await db
    .insert(receiptMatchSuggestions)
    .values(values)
    .onConflictDoUpdate({
      target: [receiptMatchSuggestions.receiptId, receiptMatchSuggestions.transactionId],
      set: {
        confidence: sql`excluded.confidence`,
        amountDiff: sql`excluded.amount_diff`,
        dateDiffDays: sql`excluded.date_diff_days`,
        vendorMatch: sql`excluded.vendor_match`,
        updatedAt: now,
      },
    });

  // Auto-apply if there's exactly one unique candidate AND it has no
  // active application yet. Multiple candidates → leave as suggestions;
  // the AI-chat card surfaces them for manual review.
  if (candidates.length === 1) {
    const receiptId = candidates[0].id;
    const [activeApp] = await db
      .select({ id: receiptMatchApplications.id })
      .from(receiptMatchApplications)
      .where(
        and(
          eq(receiptMatchApplications.receiptId, receiptId),
          isNull(receiptMatchApplications.reversedAt),
        ),
      )
      .limit(1);
    if (!activeApp) {
      // Find the suggestion we just upserted so apply has its id.
      const [sug] = await db
        .select({ id: receiptMatchSuggestions.id, confidence: receiptMatchSuggestions.confidence })
        .from(receiptMatchSuggestions)
        .where(
          and(
            eq(receiptMatchSuggestions.receiptId, receiptId),
            eq(receiptMatchSuggestions.transactionId, t.id),
            eq(receiptMatchSuggestions.status, 'pending'),
          ),
        )
        .limit(1);
      if (sug && Number(sug.confidence) >= AUTO_APPLY_MIN_CONFIDENCE) {
        try {
          const result = await applyReceiptMatch({
            organizationId: input.organizationId,
            suggestionId: sug.id,
          });
          logger.info(
            { transactionId: t.id, receiptId, applicationId: result.applicationId },
            'transaction auto-linked to existing draft receipt',
          );
        } catch (err) {
          // Most common failure: receipt lines have no account yet (AI
          // suggester miss). Suggestion stays pending; user can click
          // Accept once line accounts are sorted out.
          logger.info(
            {
              transactionId: t.id,
              receiptId,
              err: err instanceof ApplyMatchError ? err.message : err instanceof Error ? err.message : String(err),
            },
            'transaction → receipt auto-apply skipped',
          );
        }
      }
    }
  }

  return candidates.length;
}
