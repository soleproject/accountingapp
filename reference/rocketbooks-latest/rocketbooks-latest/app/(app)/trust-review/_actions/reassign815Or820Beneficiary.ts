'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import {
	resolve815Or820Context,
	resolveFoodClothingTargetForBeneficiary,
	buildFoodClothingConfirmedFinding,
	buildFoodClothingRerouteToDemandNoteFinding,
} from '@/lib/accounting/trust-food-clothing-reroute';

export interface Reassign815Or820Result {
	ok: boolean;
	newJournalEntryId?: string;
	routedTo?: 'food_clothing_source' | 'demand_note_26x';
	error?: string;
}

/**
 * Tag (or re-tag) a 815/820 line with a beneficiary AND post it to the
 * correct account for that beneficiary at the JE date:
 *
 *   qualifies (under 21 OR incapacitated at JE date) → org's 815 or 820
 *   doesn't qualify                                  → bene's 26x demand note
 *
 * Accepts all 8 actionable codes (4 × 815 + 4 × 820), open + decisioned.
 * Picking a new beneficiary on a row that's already been decisioned
 * reverses the prior posting and reposts on the new target — the unified
 * recovery path for "user picked the wrong bene last time".
 *
 * Always reverse + repost, never edit in place, so the GL keeps its audit
 * trail. Original finding auto-dismisses pointing at the new JE; a
 * TRUST_*_BENE_CONFIRMED_QUALIFYING or TRUST_*_REROUTED_TO_DEMAND_NOTE
 * audit is inserted on the new JE so Decisioned records the swap.
 */
export async function reassign815Or820Beneficiary(args: {
	findingId: string;
	beneficiaryId: string;
}): Promise<Reassign815Or820Result> {
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

	const ctx = await resolve815Or820Context({
		organizationId: orgId,
		code: finding.code,
		metadata: finding.metadata,
		journalEntryId: finding.journalEntryId,
	});
	if (!ctx.ok) return { ok: false, error: ctx.error };

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

	const target = await resolveFoodClothingTargetForBeneficiary({
		organizationId: orgId,
		beneficiaryId: args.beneficiaryId,
		kind: ctx.kind,
		asOfDate: je.date,
	});
	if (!target.ok) return { ok: false, error: target.error };

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

	const sourceLines = lines.filter((l) => l.accountId === ctx.sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== ctx.sourceAccountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching line found on this JE — nothing to reassign' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) {
		return { ok: false, error: 'Line has no positive debit amount to reassign' };
	}
	const sharedContactId = sourceLines[0]?.contactId ?? null;
	const sharedMemo = sourceLines[0]?.memo ?? null;

	// Look up the canonical food/clothing account for the audit message.
	// On reroute-to-demand-note codes the line is on a 26x, so
	// foodClothingAccountId points at the original 815/820. On on-source
	// codes it's the same as sourceAccountId. Either way, this is the
	// reference for the "rerouted FROM …" half of the audit.
	const [foodClothingAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, ctx.foodClothingAccountId))
		.limit(1);
	if (!foodClothingAcct) {
		return { ok: false, error: `Original ${ctx.kind} account missing from CoA` };
	}

	let newJeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — ${ctx.kind} line reassigned to ${target.target.accountNumber ?? ''} ${target.target.accountName} for ${target.target.beneficiaryName}`,
				},
				tx,
			);

			const newCategoryLine = {
				accountId: target.target.accountId,
				debit: totalDebit,
				credit: 0,
				contactId: sharedContactId,
				memo: sharedMemo,
				beneficiaryId: args.beneficiaryId,
			};
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
					lines: [newCategoryLine, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: target.target.accountId })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			// Insert the correct audit on the new JE. Confirmed-qualifying keeps
			// the line on 815/820; non-qualifying lands on a 26x and uses the
			// same metadata shape as the rules engine's original reroute audit.
			const auditPayload = target.target.routedTo === 'food_clothing_source'
				? buildFoodClothingConfirmedFinding({
						organizationId: orgId,
						journalEntryId: newJe.id,
						target: target.target,
						amount: totalDebit,
					})
				: buildFoodClothingRerouteToDemandNoteFinding({
						organizationId: orgId,
						journalEntryId: newJe.id,
						fromAccountId: foodClothingAcct.id,
						fromAccountNumber: foodClothingAcct.accountNumber,
						fromAccountName: foodClothingAcct.accountName,
						fromDetailType: foodClothingAcct.detailType ?? '',
						target: target.target,
						amount: totalDebit,
					});
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...auditPayload,
			});

			// Dismiss every still-open finding on the reversed JE — anything
			// else flagged on the old posting is moot now that the JE is
			// reversed; the rules engine re-fires any that still apply on the
			// new JE.
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: ${ctx.kind} line reassigned to ${target.target.accountNumber ?? ''} ${target.target.accountName} for ${target.target.beneficiaryName}. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(trustReviewFindings.journalEntryId, finding.journalEntryId),
						isNull(trustReviewFindings.dismissedAt),
					),
				);
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to reassign' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return {
		ok: true,
		newJournalEntryId: newJeId ?? undefined,
		routedTo: target.target.routedTo,
	};
}
