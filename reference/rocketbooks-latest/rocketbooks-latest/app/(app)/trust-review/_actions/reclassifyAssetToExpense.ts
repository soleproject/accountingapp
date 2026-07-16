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
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';

export interface ReclassifyAssetResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve TRUST_ASSET_REPOST_REVIEW by moving the posting off the
 * asset account onto the proper expense account (685 R&M, 605 vehicle,
 * 650 insurance, etc.). The user picks the destination.
 *
 * The "add to asset basis" branch (when it really IS a capital
 * improvement) is deferred — for that case the user dismisses this
 * finding and updates fixed_assets.cost_basis manually.
 */
export async function reclassifyAssetToExpense(args: {
	findingId: string;
	expenseAccountId: string;
}): Promise<ReclassifyAssetResult> {
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
	if (finding.code !== 'TRUST_ASSET_REPOST_REVIEW') {
		return { ok: false, error: 'reclassifyAssetToExpense only applies to TRUST_ASSET_REPOST_REVIEW' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };

	const [target] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			accountType: chartOfAccounts.accountType,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, args.expenseAccountId),
				eq(chartOfAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!target) return { ok: false, error: 'Target account not in this organization' };
	if (target.accountType !== 'expenses' && target.accountType !== 'other_expense') {
		return { ok: false, error: 'Target account is not an expense account' };
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
	const sourceLines = lines.filter((l) => l.accountId === meta.accountId);
	const otherLines = lines.filter((l) => l.accountId !== meta.accountId);
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) return { ok: false, error: 'Asset line has no debit to reclassify' };

	const [sourceAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, meta.accountId))
		.limit(1);

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — asset line reclassified to ${target.accountNumber ?? ''} ${target.accountName}`,
				},
				tx,
			);

			const newExpenseLine = {
				accountId: target.id,
				debit: totalDebit,
				credit: 0,
				contactId: sourceLines[0]?.contactId ?? null,
				memo: sourceLines[0]?.memo ?? null,
				beneficiaryId: sourceLines[0]?.beneficiaryId ?? null,
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
					lines: [newExpenseLine, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: target.id })
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
				code: 'TRUST_ASSET_RECLASSIFIED_TO_EXPENSE',
				severity: 'warn',
				message: `Moved $${totalDebit.toFixed(2)} from ${sourceAcct?.accountNumber ?? ''} ${sourceAcct?.accountName ?? 'asset'} to ${target.accountNumber ?? ''} ${target.accountName}.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: meta.accountId,
					fromAccountNumber: sourceAcct?.accountNumber,
					toAccountId: target.id,
					toAccountNumber: target.accountNumber,
					amount: totalDebit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: reclassified to ${target.accountNumber ?? ''} ${target.accountName}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to reclassify' };
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId! };
}
