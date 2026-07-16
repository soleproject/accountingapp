'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { getDemandNoteOutstanding } from '@/lib/accounting/trust-beneficiary-balance';

export interface Apply310Result {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
	appliedToDemandNote?: number;
	residualOn310?: number;
}

/**
 * Resolve a TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED finding. Spec says a
 * taxable 310 distribution shouldn't post while the beneficiary still
 * owes the trust on their 26x demand note — credit the demand note
 * first; only the residual (if any) becomes a real 310 distribution.
 *
 * Re-queries the bene's current demand-note balance at action time
 * (don't trust the rule-time snapshot — other payments may have
 * applied since). Reverses the original JE and reposts as:
 *   - Cr 265.x demand note for min(310 amount, outstanding)
 *   - Dr 310 for any residual (if 310 amount > outstanding)
 *   - bank/contra lines carried over
 *
 * When the entire amount fits in the demand note, the new JE has no
 * 310 line at all and the original K-1 finding goes away with it.
 * When there's residual on 310, the rules engine fires
 * TRUST_310_FLAG_K1_ISSUANCE on the new JE for that residual amount.
 */
export async function apply310ToDemandNote(args: {
	findingId: string;
}): Promise<Apply310Result> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED') {
		return { ok: false, error: 'apply310ToDemandNote only applies to 310 not-exhausted findings' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string; beneficiaryId?: string };
	if (!meta.accountId || !meta.beneficiaryId) {
		return { ok: false, error: 'Finding metadata missing accountId or beneficiaryId' };
	}

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
		})
		.from(trustBeneficiaries)
		.where(and(eq(trustBeneficiaries.id, meta.beneficiaryId), eq(trustBeneficiaries.organizationId, orgId)))
		.limit(1);
	if (!bene) return { ok: false, error: 'Beneficiary not found' };
	if (!bene.demandNoteAccountId) {
		return { ok: false, error: `${bene.fullName} has no demand-note account on file` };
	}

	// Re-query the current outstanding balance at action time — don't
	// trust the rule-time snapshot.
	const outstanding = await getDemandNoteOutstanding({
		demandNoteAccountId: bene.demandNoteAccountId,
	});
	if (outstanding <= 0) {
		return { ok: false, error: `${bene.fullName}'s demand-note balance is already zero — nothing to credit. Just dismiss the finding.` };
	}

	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	const lineRows = await db
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
	const distLines = lineRows.filter((l) => l.accountId === meta.accountId);
	const otherLines = lineRows.filter((l) => l.accountId !== meta.accountId);
	const totalDist = distLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDist <= 0) {
		return { ok: false, error: 'No 310 debit on this JE to apply' };
	}

	// Cents arithmetic to avoid drift.
	const distCents = Math.round(totalDist * 100);
	const outstandingCents = Math.round(outstanding * 100);
	const applyCents = Math.min(distCents, outstandingCents);
	const residualCents = distCents - applyCents;
	const applyDollars = applyCents / 100;
	const residualDollars = residualCents / 100;

	const [demandAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, bene.demandNoteAccountId))
		.limit(1);
	if (!demandAcct) return { ok: false, error: 'Demand-note account missing from CoA' };

	const sharedContactId = distLines[0]?.contactId ?? null;
	const sharedMemo = distLines[0]?.memo ?? null;

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 310 distribution applied to ${bene.fullName}'s demand note (${demandAcct.accountNumber ?? ''})`,
				},
				tx,
			);

			// New posting: credit the demand note for the applied portion
			// (reduces the beneficiary's outstanding balance), residual stays
			// on 310 if any.
			const newLines: Array<{
				accountId: string;
				debit: number;
				credit: number;
				contactId: string | null;
				memo: string | null;
				beneficiaryId: string | null;
			}> = [
				{
					accountId: demandAcct.id,
					debit: 0,
					credit: applyDollars,
					contactId: sharedContactId,
					memo: sharedMemo,
					beneficiaryId: bene.id,
				},
			];
			if (residualCents > 0) {
				newLines.push({
					accountId: meta.accountId!,
					debit: residualDollars,
					credit: 0,
					contactId: sharedContactId,
					memo: sharedMemo,
					beneficiaryId: bene.id,
				});
			}
			const carryoverLines = otherLines.map((l) => ({
				accountId: l.accountId,
				debit: Number(l.debit ?? 0),
				credit: Number(l.credit ?? 0),
				contactId: l.contactId,
				memo: l.memo,
				beneficiaryId: l.beneficiaryId ?? null,
			}));
			const newJe = await createJournalEntry(
				{
					organizationId: orgId,
					date: je.date,
					memo: je.memo,
					posted: true,
					sourceType: je.sourceType,
					sourceId: je.sourceId,
					lines: [...newLines, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({
						journalEntryId: newJe.id,
						// If the whole thing went to the demand note, the canonical
						// category is the demand note; otherwise keep 310 since
						// that's the residual (and the larger semantic event).
						categoryAccountId: residualCents > 0 ? meta.accountId! : demandAcct.id,
					})
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: newJe.id,
				code: 'TRUST_310_APPLIED_TO_DEMAND_NOTE',
				severity: 'warn',
				message: `Applied $${applyDollars.toFixed(2)} of the 310 distribution to ${bene.fullName}'s demand note (was owed $${outstanding.toFixed(2)})${residualCents > 0 ? `; $${residualDollars.toFixed(2)} residual stays on 310 and triggers K-1 issuance.` : '. Demand note now satisfied; no 310 residual.'}`,
				metadata: {
					beneficiaryId: bene.id,
					demandNoteAccountId: demandAcct.id,
					appliedAmount: applyDollars,
					residualAmount: residualDollars,
					outstandingBeforeApply: outstanding,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: $${applyDollars.toFixed(2)} of 310 applied to ${bene.fullName}'s demand note. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to apply 310 to demand note' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return {
		ok: true,
		newJournalEntryId: newJeId!,
		appliedToDemandNote: applyDollars,
		residualOn310: residualDollars,
	};
}
