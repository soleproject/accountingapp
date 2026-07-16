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

export interface RecategorizeNonTrustResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve TRUST_NON_TRUST_CATEGORY_USED by moving the line off the
 * non-BCOA account onto a trust-accepted account. User picks the
 * target.
 *
 * Preserves debit/credit direction so an expense reposting stays a
 * debit and an income reposting stays a credit. Carryover lines
 * (bank-side, etc.) are untouched.
 */
export async function recategorizeNonTrust(args: {
	findingId: string;
	targetAccountId: string;
}): Promise<RecategorizeNonTrustResult> {
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
	if (finding.code !== 'TRUST_NON_TRUST_CATEGORY_USED') {
		return { ok: false, error: 'recategorizeNonTrust only applies to TRUST_NON_TRUST_CATEGORY_USED' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };

	const [target] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, args.targetAccountId),
				eq(chartOfAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!target) return { ok: false, error: 'Target account not in this organization' };

	const [source] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, meta.accountId))
		.limit(1);

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
	if (sourceLines.length === 0) return { ok: false, error: 'No matching non-trust line on this JE' };
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — non-trust line recategorized to ${target.accountNumber ?? ''} ${target.accountName}`,
				},
				tx,
			);

			const newLine = {
				accountId: target.id,
				debit: totalDebit,
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
					lines: [newLine, ...carryoverLines],
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
				code: 'TRUST_NON_TRUST_RECATEGORIZED',
				severity: 'warn',
				message: `Moved from ${source?.accountNumber ?? ''} ${source?.accountName ?? 'non-trust account'} to ${target.accountNumber ?? ''} ${target.accountName}.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: meta.accountId,
					fromAccountNumber: source?.accountNumber,
					toAccountId: target.id,
					toAccountNumber: target.accountNumber,
					amount: totalDebit > 0 ? totalDebit : totalCredit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: recategorized to ${target.accountNumber ?? ''} ${target.accountName}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize' };
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId! };
}
