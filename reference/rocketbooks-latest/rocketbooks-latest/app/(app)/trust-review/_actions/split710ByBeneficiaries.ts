'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
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
import {
	resolveBeneficiary710Target,
	resolve710Context,
	resolveVendorContactForReroute,
} from '@/lib/accounting/trust-710-reroute';
import {
	buildFoodClothingConfirmedFinding,
	buildFoodClothingRerouteToDemandNoteFinding,
	resolveTrust815Account,
	type FoodClothingTarget,
} from '@/lib/accounting/trust-food-clothing-reroute';
import { splitAmountEvenly } from './split-utils';

export interface Split710Result {
	ok: boolean;
	newJournalEntryId?: string;
	error?: string;
}

/**
 * Reverse the JE referenced by a Trust Review finding and repost it with
 * the 710 (Meals & Entertainment) debit line split evenly across the
 * supplied beneficiaries. Each split debit lands on the CORRECT account
 * for that beneficiary, not back on 710:
 *
 *   qualifies (under 21 OR incapacitated at JE date) → 815 Food
 *   doesn't qualify                                  → 26x demand note
 *
 * Per-beneficiary routing means a single 710 line can split into multiple
 * accounts — e.g. one bene to 815, two adults each to their own 26x — all
 * tagged with the matching beneficiary via beneficiary_id. All non-710
 * lines (bank, etc.) carry over unchanged.
 *
 * Audit trail: the original JE remains in the GL (reversed via a counter-
 * entry, never deleted). The original finding is auto-dismissed; an
 * 815-family audit (TRUST_815_BENE_CONFIRMED_QUALIFYING or
 * TRUST_815_REROUTED_TO_DEMAND_NOTE) is inserted on the new JE for each
 * split line — bene-tagging re-characterizes 710 lines as food expenses,
 * so the audit family matches what 815-originated posts would produce.
 */
export async function split710ByBeneficiaries(args: {
	findingId: string;
	beneficiaryIds: string[];
}): Promise<Split710Result> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.beneficiaryIds.length < 2) {
		return { ok: false, error: 'Split needs at least two beneficiaries' };
	}

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

	const ctx = resolve710Context(finding.code, finding.metadata);
	if (!ctx.ok) return { ok: false, error: ctx.error };
	const { sourceAccountId } = ctx;

	// Validate beneficiaries belong to org.
	const benes = await db
		.select({ id: trustBeneficiaries.id, fullName: trustBeneficiaries.fullName })
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.organizationId, orgId),
				inArray(trustBeneficiaries.id, args.beneficiaryIds),
			),
		);
	if (benes.length !== args.beneficiaryIds.length) {
		return { ok: false, error: 'One or more beneficiaries not found in this organization' };
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

	// Bucket the source-account lines (we're going to replace them) vs
	// everything else (carries over unchanged). For an open finding the
	// source is the original 710 account; for a decisioned finding it's
	// the current rerouted destination.
	const meLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (meLines.length === 0) {
		return { ok: false, error: 'No matching lines found on this JE — cannot split' };
	}

	// Sum all 710 debits and split evenly. (If multiple 710 lines existed
	// already, we collapse them into the split.)
	const totalCents = meLines.reduce(
		(acc, l) => acc + Math.round(Number(l.debit ?? 0) * 100),
		0,
	);
	if (totalCents <= 0) {
		return { ok: false, error: '710 line has no positive debit amount to split' };
	}

	// Resolve each beneficiary's target account up front so the whole split
	// either succeeds (every bene routable) or aborts before we touch the GL.
	const perBeneTargets: Array<{ beneId: string; target: Awaited<ReturnType<typeof resolveBeneficiary710Target>> }> = [];
	for (const beneId of args.beneficiaryIds) {
		const r = await resolveBeneficiary710Target({
			organizationId: orgId,
			beneficiaryId: beneId,
			asOfDate: je.date,
		});
		if (!r.ok) {
			return { ok: false, error: r.error };
		}
		perBeneTargets.push({ beneId, target: r });
	}

	// Bene-tagging re-characterizes each split as a food expense, so the
	// per-split audit lives in the 815 family. Look up the canonical 815
	// account once for the "from" reference (the demand-note path needs it
	// even though the GL line never visits 815).
	const food815 = await resolveTrust815Account(orgId);
	if (!food815.ok) return { ok: false, error: food815.error };

	const splitCents = splitAmountEvenly(totalCents, args.beneficiaryIds.length);
	// Trustee-tagged source → fall back to the transaction vendor; see
	// reroute710ToBeneficiary for the rationale.
	const sharedContactId = await resolveVendorContactForReroute({
		organizationId: orgId,
		sourceContactId: meLines[0]?.contactId ?? null,
		jeSourceType: je.sourceType,
		jeSourceId: je.sourceId,
	});
	const sharedMemo = meLines[0]?.memo ?? null;

	let newJeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			// Reverse the original JE — adds a counter-entry; the original
			// rows stay for the audit trail.
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 710 line split + rerouted across ${args.beneficiaryIds.length} beneficiaries`,
				},
				tx,
			);

			// Each split line lands on the beneficiary's correct target
			// (815 for qualifying, 26x for non-qualifying).
			const newSplitLines = perBeneTargets.map((p, i) => {
				if (!p.target.ok) throw new Error('unreachable — checked above');
				return {
					accountId: p.target.target.accountId,
					debit: splitCents[i] / 100,
					credit: 0,
					contactId: sharedContactId,
					memo: sharedMemo,
					beneficiaryId: p.beneId,
				};
			});

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
					lines: [...newSplitLines, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			// Re-point the transactions row at the new JE so future categorize
			// edits / receipt-link flows operate on the correct entry. Don't
			// touch categoryAccountId here — split JEs have multiple category
			// lines so a single canonical value isn't meaningful.
			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			// Insert one 815-family audit per split line. Each bene-tagged
			// split is conceptually a food expense; qualifying stays on 815,
			// non-qualifying is rerouted to that bene's 26x.
			for (let i = 0; i < perBeneTargets.length; i++) {
				const p = perBeneTargets[i];
				if (!p.target.ok) continue;
				const fcTarget: FoodClothingTarget = {
					accountId: p.target.target.accountId,
					accountNumber: p.target.target.accountNumber,
					accountName: p.target.target.accountName,
					routedTo: p.target.target.routedTo === 'food_815'
						? 'food_clothing_source'
						: 'demand_note_26x',
					kind: '815',
					beneficiaryId: p.target.target.beneficiaryId,
					beneficiaryName: p.target.target.beneficiaryName,
					ageNote: p.target.target.ageNote,
				};
				const audit = fcTarget.routedTo === 'food_clothing_source'
					? buildFoodClothingConfirmedFinding({
							organizationId: orgId,
							journalEntryId: newJe.id,
							target: fcTarget,
							amount: splitCents[i] / 100,
						})
					: buildFoodClothingRerouteToDemandNoteFinding({
							organizationId: orgId,
							journalEntryId: newJe.id,
							fromAccountId: food815.accountId,
							fromAccountNumber: food815.accountNumber,
							fromAccountName: food815.accountName,
							fromDetailType: 'trust_food_minors_incapacitated',
							target: fcTarget,
							amount: splitCents[i] / 100,
						});
				await tx.insert(trustReviewFindings).values({
					id: randomUUID(),
					...audit,
				});
			}

			// Auto-dismiss every still-open finding on the reversed JE —
			// not just the triggering one. The old JE no longer represents a
			// live posting, so unrelated open warnings (no-receipt, etc.)
			// would otherwise linger in the queue.
			const beneNames = benes.map((b) => b.fullName).join(', ');
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 710 line split + rerouted across ${args.beneficiaryIds.length} beneficiaries (${beneNames}). See JE ${newJe.id.slice(0, 8)}.`,
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
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to split JE' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return { ok: true, newJournalEntryId: newJeId ?? undefined };
}
