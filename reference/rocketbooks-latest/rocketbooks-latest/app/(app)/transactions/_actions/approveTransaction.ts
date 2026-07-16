'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { assertNotDemo } from '@/lib/auth/demo';
import { recordFirmChange } from '@/lib/enterprise/attribution';
import {
  pendingRuleForTransaction,
  pendingContactCategorization,
  promoteRule,
  type ContactCategorizeSuggestion,
} from '@/lib/accounting/rule-promotion';
import { categorizeTransaction } from '@/lib/accounting/categorize';

/**
 * Mark one or more transactions as reviewed without changing the category.
 *
 * Used by the to_review queue: when the auto-classification is correct
 * (e.g. a clearly-classified transfer the user is fine leaving uncategorized,
 * or a personal expense already routed to Personal Expense), the user clicks
 * Approve and the row leaves the queue. Does not touch journal_entry_id —
 * approving doesn't change the GL. If the row already has a JE, it stays
 * pointed at the same one; if it doesn't, approving doesn't post one (the
 * categorize action handles posting via repostTransactionJE).
 */

const Single = z.object({ transactionId: z.string().min(1) });
const Bulk = z.object({ transactionIds: z.array(z.string().min(1)).min(1).max(500) });

export interface ApproveState { ok?: boolean; count?: number; error?: string }

export async function approveTransaction(
  _prev: ApproveState | undefined,
  formData: FormData,
): Promise<ApproveState> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'approve transactions');
  const parsed =Single.safeParse({ transactionId: formData.get('transactionId') });
  if (!parsed.success) return { error: 'Invalid input' };

  const result = await db
    .update(transactions)
    .set({ reviewed: true })
    .where(and(eq(transactions.id, parsed.data.transactionId), eq(transactions.organizationId, orgId)))
    .returning({ id: transactions.id });

  if (result.length === 0) return { error: 'Transaction not found in this organization' };

  await recordFirmChange({ action: 'approve', orgId, entityType: 'transaction', entityId: parsed.data.transactionId, summary: 'Approved a transaction' });
  revalidatePath('/transactions');
  return { ok: true, count: 1 };
}

export interface PendingRuleSuggestion {
  pattern: string;
  categoryAccountId: string;
  categoryName: string;
  count: number;
  /** Direction the rule is scoped to ('deposit'|'withdrawal'|null). */
  transactionType: string | null;
}
export interface ReviewedState {
  ok?: boolean;
  reviewed?: boolean;
  /** When verifying a row whose merchant has a not-yet-created rule, the
   *  suggestion the user can one-click accept (create rule + verify matching). */
  suggestion?: PendingRuleSuggestion | null;
  /** When there's no rule but other same-contact transactions could be aligned
   *  to this category, the one-click "categorize the rest" suggestion. */
  contactSuggestion?: ContactCategorizeSuggestion | null;
  error?: string;
}

/** Toggle a single transaction's human-verified flag to the value in the form. */
export async function setTransactionReviewed(
  _prev: ReviewedState | undefined,
  formData: FormData,
): Promise<ReviewedState> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'review transactions');
  const id = String(formData.get('transactionId') ?? '');
  if (!id) return { error: 'Invalid input' };
  const target = String(formData.get('reviewed') ?? '') === '1';

  const result = await db
    .update(transactions)
    .set({ verified: target })
    .where(and(eq(transactions.id, id), eq(transactions.organizationId, orgId)))
    .returning({ id: transactions.id });

  if (result.length === 0) return { error: 'Transaction not found in this organization' };

  await recordFirmChange({
    action: target ? 'approve' : 'unreview',
    orgId,
    entityType: 'transaction',
    entityId: id,
    summary: target ? 'Verified a transaction' : 'Unverified a transaction',
  });
  revalidatePath('/transactions');

  // On verify: offer to promote a rule for this merchant if one is pending;
  // otherwise offer to align other transactions for the same contact.
  const suggestion = target ? await pendingRuleForTransaction(orgId, id) : null;
  const contactSuggestion = target && !suggestion ? await pendingContactCategorization(orgId, id) : null;
  return { ok: true, reviewed: target, suggestion, contactSuggestion };
}

/** Categorize every UNVERIFIED transaction for a contact to the given account
 *  (posting JEs) and mark them verified. */
export async function acceptContactCategorization(
  _prev: AcceptRuleState | undefined,
  formData: FormData,
): Promise<AcceptRuleState> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'categorize transactions');
  const contactId = String(formData.get('contactId') ?? '');
  const categoryAccountId = String(formData.get('categoryAccountId') ?? '');
  const transactionType = String(formData.get('transactionType') ?? '') || null;
  if (!contactId || !categoryAccountId) return { error: 'Invalid input' };

  // Only align OTHER SAME-DIRECTION transactions for the contact.
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, orgId),
        eq(transactions.contactId, contactId),
        eq(transactions.verified, false),
        sql`${transactions.categoryAccountId} is distinct from ${categoryAccountId}`,
        ...(transactionType ? [eq(transactions.type, transactionType)] : []),
      ),
    );

  let count = 0;
  for (const r of rows) {
    const res = await categorizeTransaction({ organizationId: orgId, transactionId: r.id, categoryAccountId });
    if (res.ok) count += 1;
  }
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .update(transactions)
      .set({ verified: true })
      .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, ids)));
  }

  await recordFirmChange({
    action: 'contact_categorize',
    orgId,
    entityType: 'contact',
    entityId: contactId,
    summary: `Categorized + verified ${count} transaction${count === 1 ? '' : 's'} for a contact`,
  });
  revalidatePath('/transactions');
  return { ok: true, verified: count };
}

export interface VerifyGroupResult {
  ok?: boolean;
  verified?: number;
  /** Pending rule suggestion for the merchant (pop the rule card). */
  suggestion?: PendingRuleSuggestion | null;
  /** Otherwise, the "categorize the rest of this contact" suggestion (contact card). */
  contactSuggestion?: ContactCategorizeSuggestion | null;
  error?: string;
}

/**
 * Deterministically verify a guided-review group — the "Yes" button in the
 * "Review AI Categorized" flow. Sets verified=true on the ids and returns the
 * pending rule / contact suggestion so the client can pop the decision card.
 * Same effect as the verify_transaction_ids AI tool, but called directly from
 * the client so the model is never in the critical path (it was skipping the
 * tool for trivial single-transaction groups).
 */
export async function verifyGuideGroup(transactionIds: string[]): Promise<VerifyGroupResult> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'verify transactions');
  const ids = (transactionIds ?? []).filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) return { error: 'No transactions to verify' };

  const updated = await db
    .update(transactions)
    .set({ verified: true })
    .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, ids)))
    .returning({ id: transactions.id });
  if (updated.length === 0) return { error: 'Transactions not found in this organization' };

  // Same post-verify offers as the manual green check / verify tool.
  const first = ids[0];
  const suggestion = await pendingRuleForTransaction(orgId, first);
  const contactSuggestion = suggestion ? null : await pendingContactCategorization(orgId, first);

  await recordFirmChange({
    action: 'approve_bulk',
    orgId,
    entityType: 'transaction',
    summary: `Verified ${updated.length} transaction${updated.length === 1 ? '' : 's'}`,
  });
  revalidatePath('/transactions');
  return { ok: true, verified: updated.length, suggestion, contactSuggestion };
}

export interface AcceptRuleState { ok?: boolean; verified?: number; error?: string }

/** Accept a pending rule suggestion: create the rule + mark every transaction
 *  for that merchant as verified. */
export async function acceptRuleAndVerify(
  _prev: AcceptRuleState | undefined,
  formData: FormData,
): Promise<AcceptRuleState> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'create categorization rule');
  const pattern = String(formData.get('pattern') ?? '').trim();
  const categoryAccountId = String(formData.get('categoryAccountId') ?? '');
  const transactionType = String(formData.get('transactionType') ?? '') || null;
  if (!pattern || !categoryAccountId) return { error: 'Invalid input' };

  const promoted = await promoteRule(orgId, pattern, categoryAccountId, transactionType);
  if (!promoted.ok) return { error: promoted.error ?? 'Could not create rule' };

  // Verify the same merchant's transactions, scoped to this rule's direction.
  const updated = (await db.execute(sql`
    update transactions set verified = true
    where organization_id = ${orgId} and id in (
      select t.id from transactions t
      left join contacts c on c.id = t.contact_id
      where t.organization_id = ${orgId}
        and (${transactionType}::text is null or t.type = ${transactionType})
        and lower(coalesce(c.contact_name, t.bank_description, t.description)) = lower(${pattern})
    )
    returning id
  `)) as unknown as Array<unknown>;
  const count = Array.isArray(updated) ? updated.length : 0;

  await recordFirmChange({
    action: 'rule_verify',
    orgId,
    entityType: 'rule',
    summary: `Created rule "${pattern}" and verified ${count} transaction${count === 1 ? '' : 's'}`,
  });
  revalidatePath('/transactions');
  revalidatePath('/transactions/rules');
  return { ok: true, verified: count };
}

export async function approveTransactionsBulk(
  _prev: ApproveState | undefined,
  formData: FormData,
): Promise<ApproveState> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'approve transactions');
  const parsed =Bulk.safeParse({
    transactionIds: formData.getAll('ids').map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: 'Pick at least one transaction' };

  const result = await db
    .update(transactions)
    .set({ reviewed: true })
    .where(and(inArray(transactions.id, parsed.data.transactionIds), eq(transactions.organizationId, orgId)))
    .returning({ id: transactions.id });

  await recordFirmChange({ action: 'approve_bulk', orgId, entityType: 'transaction', summary: `Approved ${result.length} transaction${result.length === 1 ? '' : 's'}` });
  revalidatePath('/transactions');
  return { ok: true, count: result.length };
}
