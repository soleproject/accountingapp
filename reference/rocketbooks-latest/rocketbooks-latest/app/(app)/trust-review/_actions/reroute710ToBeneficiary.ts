'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
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

export interface Reroute710Result {
	ok: boolean;
	newJournalEntryId?: string;
	routedTo?: 'food_815' | 'demand_note_26x';
	error?: string;
}

/**
 * Tag a 710 (Meals & Entertainment) line with a beneficiary AND reroute
 * the posting to the correct destination account for that beneficiary:
 *
 *   qualifies (under 21 OR incapacitated at JE date) → 815 Food
 *   doesn't qualify                                  → 26x demand note
 *
 * Accepts the open 710 attribution finding AND the decisioned audit-trail
 * codes — picking a new beneficiary on a row that's already been rerouted
 * reverses the prior reroute and reposts on the new target. Either way,
 * the source line's *current* account is read from metadata and the
 * audit-trail message references the original 710 account.
 *
 * Always reverse + repost, never edit in place, so the GL keeps its audit
 * trail. Original finding auto-dismisses with a note pointing at the new
 * JE; an 815-family audit (TRUST_815_BENE_CONFIRMED_QUALIFYING or
 * TRUST_815_REROUTED_TO_DEMAND_NOTE) is inserted on the new JE so the
 * queue records the swap. The 815 family is used because bene-tagging a
 * 710 line re-characterizes it as a food expense — the decisioned group
 * matches what a manual 815 post tagged with the same bene would produce,
 * regardless of whether the line started on 710 or 815.
 */
export async function reroute710ToBeneficiary(args: {
	findingId: string;
	beneficiaryId: string;
}): Promise<Reroute710Result> {
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

	const ctx = resolve710Context(finding.code, finding.metadata);
	if (!ctx.ok) return { ok: false, error: ctx.error };
	const { sourceAccountId } = ctx;

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

	const target = await resolveBeneficiary710Target({
		organizationId: orgId,
		beneficiaryId: args.beneficiaryId,
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

	const meLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (meLines.length === 0) {
		return { ok: false, error: 'No matching line found on this JE — nothing to reroute' };
	}

	// Bene-tagging a 710 line re-characterizes it as a food expense, so the
	// audit lands in the 815 family (qualifying → stays on 815; non-
	// qualifying → 26x reroute). We need the canonical 815 account for the
	// audit's "from" reference even on the non-qualifying path (the GL line
	// goes straight 710 → 26x, but the audit message reads "Food (815) line
	// tagged for X — rerouted to demand note").
	const food815 = await resolveTrust815Account(orgId);
	if (!food815.ok) return { ok: false, error: food815.error };

	const totalDebit = meLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) {
		return { ok: false, error: '710 line has no positive debit amount to reroute' };
	}
	// If the source line carries a trustee contact (set by a prior trustee
	// attribution), substitute the transaction's vendor — a demand-note /
	// 815 advance is about the vendor, not the trustee.
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
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 710 rerouted to ${target.target.accountNumber ?? ''} ${target.target.accountName} for ${target.target.beneficiaryName}`,
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

			// Re-shape the 710 target into the FoodClothingTarget structure
			// the 815-family audit builders expect. kind is always '815'
			// because 710 is meals; clothing (820) attribution doesn't come
			// in via 710.
			const fcTarget: FoodClothingTarget = {
				accountId: target.target.accountId,
				accountNumber: target.target.accountNumber,
				accountName: target.target.accountName,
				routedTo: target.target.routedTo === 'food_815'
					? 'food_clothing_source'
					: 'demand_note_26x',
				kind: '815',
				beneficiaryId: target.target.beneficiaryId,
				beneficiaryName: target.target.beneficiaryName,
				ageNote: target.target.ageNote,
			};
			const auditPayload = fcTarget.routedTo === 'food_clothing_source'
				? buildFoodClothingConfirmedFinding({
						organizationId: orgId,
						journalEntryId: newJe.id,
						target: fcTarget,
						amount: totalDebit,
					})
				: buildFoodClothingRerouteToDemandNoteFinding({
						organizationId: orgId,
						journalEntryId: newJe.id,
						fromAccountId: food815.accountId,
						fromAccountNumber: food815.accountNumber,
						fromAccountName: food815.accountName,
						fromDetailType: 'trust_food_minors_incapacitated',
						target: fcTarget,
						amount: totalDebit,
					});
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...auditPayload,
			});

			// Dismiss every still-open finding on the reversed JE — not just
			// the triggering one. Anything else the rules engine flagged on
			// the old posting (e.g. TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION)
			// is moot now that the JE is reversed; the rules engine will
			// re-fire any that still apply on the new JE.
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 710 line rerouted to ${target.target.accountNumber ?? ''} ${target.target.accountName} for ${target.target.beneficiaryName}. See JE ${newJe.id.slice(0, 8)}.`,
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
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to reroute' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return { ok: true, newJournalEntryId: newJeId ?? undefined, routedTo: target.target.routedTo };
}
