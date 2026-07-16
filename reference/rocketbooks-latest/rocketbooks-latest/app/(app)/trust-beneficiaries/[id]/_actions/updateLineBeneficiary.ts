'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
  trustBeneficiaries,
  trustReviewFindings,
  journalEntries,
  journalEntryLines,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

export interface UpdateLineBeneficiaryResult {
  ok: boolean;
  error?: string;
}

/**
 * Re-tag (or untag, when beneficiaryId is empty) a single journal_entry_line
 * with a new beneficiary, then re-evaluate the JE's trust rules so the
 * Review queue findings stay current.
 *
 * Used by the inline picker on the beneficiary detail "Transactions" view
 * card — lets the user reassign a tagged line to a different beneficiary
 * without leaving the page.
 */
export async function updateLineBeneficiary(args: {
  lineId: string;
  beneficiaryId: string | null;
}): Promise<UpdateLineBeneficiaryResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [line] = await db
    .select({
      id: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(
      and(
        eq(journalEntryLines.id, args.lineId),
        eq(journalEntries.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!line) return { ok: false, error: 'Line not found' };

  if (args.beneficiaryId) {
    const [bene] = await db
      .select({ id: trustBeneficiaries.id })
      .from(trustBeneficiaries)
      .where(
        and(
          eq(trustBeneficiaries.id, args.beneficiaryId),
          eq(trustBeneficiaries.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!bene) return { ok: false, error: 'Beneficiary not in this organization' };
  }

  await db
    .update(journalEntryLines)
    .set({ beneficiaryId: args.beneficiaryId })
    .where(eq(journalEntryLines.id, args.lineId));

  // Re-evaluate the JE so Trust Review findings update.
  const [je] = await db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
    })
    .from(journalEntries)
    .where(eq(journalEntries.id, line.journalEntryId))
    .limit(1);
  if (!je) return { ok: true };

  const lines = await db
    .select({
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      contactId: journalEntryLines.contactId,
      memo: journalEntryLines.memo,
      beneficiaryId: journalEntryLines.beneficiaryId,
    })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, je.id));

  const result = await evaluateBeneficialTrustJournalEntry({
    organizationId: orgId,
    date: je.date,
    memo: je.memo,
    sourceType: je.sourceType,
    sourceId: je.sourceId,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: Number(l.debit),
      credit: Number(l.credit),
      contactId: l.contactId,
      memo: l.memo,
      beneficiaryId: l.beneficiaryId ?? null,
    })),
  });

  await db.transaction(async (tx) => {
    const priorDismissed = await tx
      .select({
        code: trustReviewFindings.code,
        dismissedAt: trustReviewFindings.dismissedAt,
        dismissedByUserId: trustReviewFindings.dismissedByUserId,
        dismissedNote: trustReviewFindings.dismissedNote,
      })
      .from(trustReviewFindings)
      .where(
        and(
          eq(trustReviewFindings.journalEntryId, je.id),
          isNotNull(trustReviewFindings.dismissedAt),
        ),
      );
    const dismissedByCode = new Map(priorDismissed.map((d) => [d.code, d]));

    await tx
      .delete(trustReviewFindings)
      .where(eq(trustReviewFindings.journalEntryId, je.id));

    if (result.findings.length > 0) {
      await tx.insert(trustReviewFindings).values(
        result.findings.map((f) => {
          const dismiss = dismissedByCode.get(f.code);
          return {
            id: randomUUID(),
            organizationId: orgId,
            journalEntryId: je.id,
            code: f.code,
            severity: f.severity,
            message: f.message,
            metadata: f.metadata ?? null,
            dismissedAt: dismiss?.dismissedAt ?? null,
            dismissedByUserId: dismiss?.dismissedByUserId ?? null,
            dismissedNote: dismiss?.dismissedNote ?? null,
          };
        }),
      );
    }
  });

  revalidatePath('/trust-beneficiaries');
  revalidatePath(`/trust-beneficiaries/${orgId}`);
  revalidatePath('/trust-review');
  return { ok: true };
}
