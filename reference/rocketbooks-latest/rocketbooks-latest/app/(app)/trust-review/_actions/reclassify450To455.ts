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

export interface Reclassify450Result {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve TRUST_450_BUSINESS_INCOME_BLOCKED by reclassifying a direct
 * business-income deposit to 455 K-1 income — the spec-correct route
 * (income flows through an LLC/S-Corp K-1, not posted directly to the
 * trust). Caller MUST ensure a valid source K-1 exists from an external
 * operating entity; the action does not verify the K-1.
 *
 * 450 is rule-blocked at posting time, so in normal operation this
 * finding shouldn't exist in the queue. Action is here for legacy data
 * (postings predating the block) and explicit dismissal cases.
 */
export async function reclassify450To455(args: {
	findingId: string;
}): Promise<Reclassify450Result> {
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
	if (finding.code !== 'TRUST_450_BUSINESS_INCOME_BLOCKED') {
		return { ok: false, error: 'reclassify450To455 only applies to 450 findings' };
	}

	const meta = (finding.metadata ?? {}) as { accountNumber?: string };
	if (!meta.accountNumber) return { ok: false, error: 'Finding metadata missing accountNumber' };

	// Source 450 account + target 455 account.
	const accounts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.organizationId, orgId));
	const source = accounts.find((a) => a.detailType === 'trust_business_income');
	const target = accounts.find((a) => a.detailType === 'trust_k1_income');
	if (!source) return { ok: false, error: 'No 450 Business Income account on this org' };
	if (!target) return { ok: false, error: 'No 455 K-1 Income account on this org' };

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
	const sourceLines = lines.filter((l) => l.accountId === source.id);
	const otherLines = lines.filter((l) => l.accountId !== source.id);
	if (sourceLines.length === 0) return { ok: false, error: 'No 450 line on this JE' };
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
	if (totalCredit <= 0) return { ok: false, error: 'No 450 credit to reclassify' };

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 450 reclassified to 455 K-1 income`,
				},
				tx,
			);

			const newK1Line = {
				accountId: target.id,
				debit: 0,
				credit: totalCredit,
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
					lines: [newK1Line, ...carryoverLines],
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
				code: 'TRUST_450_RECLASSIFIED_TO_K1',
				severity: 'warn',
				message: `$${totalCredit.toFixed(2)} business income moved from 450 to 455 K-1. CPA: confirm a source K-1 from a valid external operating entity (LLC/S-Corp) is on file.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: source.id,
					fromAccountNumber: source.accountNumber,
					toAccountId: target.id,
					toAccountNumber: target.accountNumber,
					amount: totalCredit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: reclassified 450 → 455. See JE ${newJe.id.slice(0, 8)}.`,
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
