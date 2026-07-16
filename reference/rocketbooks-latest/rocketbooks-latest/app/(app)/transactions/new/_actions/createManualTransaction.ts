'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, contacts, chartOfAccounts, trustBeneficiaries, trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { findReceiptMatchesForTransaction } from '@/lib/receipts/find-receipt-matches-for-transaction';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError, buildUnlockCta } from '@/lib/billing/entitlements';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { maybeRerouteFor815820, buildRerouteFinding } from '@/lib/accounting/trust-reroute';
import { logger } from '@/lib/logger';

const InputSchema = z.object({
  type: z.enum(['deposit', 'withdrawal']),
  date: z.iso.date(),
  amount: z.coerce.number().positive(),
  bankAccountId: z.string().min(1),
  categoryAccountId: z.string().min(1),
  contactId: z.string().optional(),
  description: z.string().max(500).optional(),
  // Phase 4d: required when categoryAccount is a per-beneficiary account
  // on a trust org. Lands on the category-side JE line only.
  beneficiaryId: z.string().optional().nullable(),
});

const PER_BENEFICIARY_DETAIL_TYPES = new Set<string>([
  'trust_food_minors_incapacitated',
  'trust_clothing_minors_incapacitated',
  'trust_distributions_to_beneficiaries',
  'trust_medical_wellness',
]);
export interface CreateManualTransactionState {
  error?: string;
  /**
   * Set alongside error when the failure was a date-not-covered case and
   * a matching year-unlock SKU exists. Drives the inline Buy button so
   * the customer can purchase the unlock without leaving the page.
   */
  unlockProductId?: string;
  unlockLabel?: string;
}

/**
 * Manually book a deposit or withdrawal. Creates a transactions row plus a
 * balanced JE in one transaction. Deposit: Dr bank, Cr category. Withdrawal:
 * Dr category, Cr bank.
 *
 * Sets transactions.reviewed=true since the user explicitly chose the
 * category — no auto-categorize loop needs to look at it.
 */
export async function createManualTransaction(
  _prev: CreateManualTransactionState | undefined,
  formData: FormData,
): Promise<CreateManualTransactionState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  // The unified CategorySelect can return an `intent` of bill_payment /
  // invoice_payment instead of a plain category id. Single-mode create
  // doesn't yet handle the AP/AR resolution + payments-row wiring that
  // those intents require, so reject with a hint pointing the user at
  // the edit page (where splitTransaction handles it). Plain account
  // picks fall through unchanged.
  const intentChoice = formData.get('intent');
  if (typeof intentChoice === 'string' && intentChoice) {
    return {
      error:
        'Bill / invoice payments aren’t supported on the create form yet. Save with a plain category, then apply the payment from the transaction detail page.',
    };
  }

  const parsed = InputSchema.safeParse({
    type: formData.get('type'),
    date: formData.get('date'),
    amount: formData.get('amount'),
    bankAccountId: formData.get('bankAccountId'),
    categoryAccountId: formData.get('categoryAccountId'),
    contactId: formData.get('contactId') || undefined,
    description: formData.get('description') || undefined,
    beneficiaryId: formData.get('beneficiaryId') || null,
  });
  if (!parsed.success) {
    return { error: 'Invalid input. Date, amount, bank account, and category are required.' };
  }

  try {
    await requireDateCovered(orgId, parsed.data.date);
  } catch (e) {
    if (e instanceof DateNotCoveredError) {
      return { error: e.message, ...(await buildUnlockCta(e)) };
    }
    throw e;
  }

  // Validate every account / contact belongs to the org.
  const accountIds = [parsed.data.bankAccountId, parsed.data.categoryAccountId];
  const orgAccounts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
  if (accountIds.some((id) => !orgAccountIds.has(id))) {
    return { error: 'One or more accounts not in this organization' };
  }
  if (parsed.data.contactId) {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.organizationId, orgId)))
      .limit(1);
    if (!c) return { error: 'Contact not in this organization' };
  }

  // Phase 4d: per-line beneficiary gate. Required when the category is a
  // per-beneficiary trust account on a trust-feature-enabled org. 815/820
  // additionally require the beneficiary to qualify (under 21 OR
  // incapacitated). Defense in depth — the rules engine BLOCKS at posting
  // time too.
  let resolvedBeneficiaryId: string | null = parsed.data.beneficiaryId ?? null;
  const [categoryAcct] = await db
    .select({ id: chartOfAccounts.id, detailType: chartOfAccounts.detailType })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.id, parsed.data.categoryAccountId),
        eq(chartOfAccounts.organizationId, orgId),
      ),
    )
    .limit(1);
  const requiresBeneficiary =
    !!categoryAcct?.detailType && PER_BENEFICIARY_DETAIL_TYPES.has(categoryAcct.detailType);
  if (requiresBeneficiary) {
    const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');
    if (trustEnabled) {
      if (!resolvedBeneficiaryId) {
        return { error: 'This account requires you to tag a beneficiary before posting.' };
      }
      const [bene] = await db
        .select({
          id: trustBeneficiaries.id,
          fullName: trustBeneficiaries.fullName,
          dateOfBirth: trustBeneficiaries.dateOfBirth,
          isIncapacitated: trustBeneficiaries.isIncapacitated,
        })
        .from(trustBeneficiaries)
        .where(
          and(
            eq(trustBeneficiaries.id, resolvedBeneficiaryId),
            eq(trustBeneficiaries.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!bene) {
        return { error: 'Selected beneficiary is not part of this organization.' };
      }
      // 815/820 with non-qualifying tagged beneficiary now reroutes to the
      // beneficiary's demand-note account instead of blocking. Reroute is
      // applied below, just before JE creation.
    } else {
      resolvedBeneficiaryId = null;
    }
  } else {
    resolvedBeneficiaryId = null;
  }

  // Trust 815/820 reroute: rewrite the category line to the beneficiary's
  // demand note (26x) when the tagged beneficiary doesn't qualify.
  const rerouteResult = await maybeRerouteFor815820({
    organizationId: orgId,
    categoryAccountId: parsed.data.categoryAccountId,
    beneficiaryId: resolvedBeneficiaryId,
    date: parsed.data.date,
  });
  const finalCategoryAccountId = rerouteResult.categoryAccountId;

  const txnId = randomUUID();
  const now = new Date().toISOString();
  const memo = parsed.data.description ?? null;
  const isDeposit = parsed.data.type === 'deposit';

  try {
    await db.transaction(async (tx) => {
      // JE first — debit/credit driven by transaction direction.
      // beneficiaryId rides on the category-side line only (bank-side stays null).
      const jeLines = isDeposit
        ? [
            {
              accountId: parsed.data.bankAccountId,
              debit: parsed.data.amount,
              credit: 0,
              contactId: parsed.data.contactId ?? null,
              memo,
              beneficiaryId: null,
            },
            {
              accountId: finalCategoryAccountId,
              debit: 0,
              credit: parsed.data.amount,
              contactId: parsed.data.contactId ?? null,
              memo,
              beneficiaryId: resolvedBeneficiaryId,
            },
          ]
        : [
            {
              accountId: finalCategoryAccountId,
              debit: parsed.data.amount,
              credit: 0,
              contactId: parsed.data.contactId ?? null,
              memo,
              beneficiaryId: resolvedBeneficiaryId,
            },
            {
              accountId: parsed.data.bankAccountId,
              debit: 0,
              credit: parsed.data.amount,
              contactId: parsed.data.contactId ?? null,
              memo,
              beneficiaryId: null,
            },
          ];
      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: parsed.data.date,
          memo: memo ?? `Manual ${parsed.data.type}`,
          posted: true,
          sourceType: 'transaction',
          sourceId: txnId,
          lines: jeLines,
        },
        tx,
      );

      await tx.insert(transactions).values({
        id: txnId,
        organizationId: orgId,
        date: parsed.data.date,
        type: parsed.data.type,
        amount: parsed.data.amount,
        accountId: parsed.data.bankAccountId,
        categoryAccountId: finalCategoryAccountId,
        contactId: parsed.data.contactId ?? null,
        description: memo,
        userDescription: memo,
        bankDescription: memo,
        journalEntryId: je.id,
        reviewed: true,
        createdAt: now,
      });

      // Trust 815/820 reroute → drop a Trust Review finding describing
      // the swap. Inserted inside the same tx so the JE + finding land
      // atomically.
      if (rerouteResult.reroute) {
        const finding = buildRerouteFinding({
          organizationId: orgId,
          journalEntryId: je.id,
          reroute: rerouteResult.reroute,
        });
        await tx.insert(trustReviewFindings).values({
          id: randomUUID(),
          ...finding,
        });
      }
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  // Best-effort: check whether the newly-created txn has an exact
  // amount + date match against a draft receipt. If yes, the helper
  // auto-applies (when unambiguous) or persists a suggestion the
  // AI-chat card will surface. Failures swallow — create succeeded.
  try {
    await findReceiptMatchesForTransaction({ organizationId: orgId, transactionId: txnId });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), txnId }, 'findReceiptMatchesForTransaction failed (non-fatal)');
  }

  // Best-effort, flag-only duplicate detection (writes book_review_findings).
  // Catches a manual entry that doubles an existing Plaid/manual transaction —
  // the (org, reference) unique index can't see this since manual rows have no
  // Plaid reference. Never blocks the create.
  try {
    const [{ detectDuplicates }, { writeFindings }] = await Promise.all([
      import('@/lib/audit/duplicates'),
      import('@/lib/audit/findings'),
    ]);
    const findings = await detectDuplicates(orgId, {
      id: txnId,
      date: parsed.data.date,
      amount: parsed.data.amount,
      type: parsed.data.type,
      contactId: parsed.data.contactId ?? null,
      description: memo,
    });
    if (findings.length > 0) await writeFindings(orgId, findings);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), txnId }, 'duplicate detection failed (non-fatal)');
  }

  revalidatePath('/transactions');
  redirect(`/transactions/${txnId}`);
}
