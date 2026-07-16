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

export interface RecategorizeContactVehicleExpenseResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk action for "this contact's 605 line isn't a vehicle
 * expense at all". Reverses each finding's JE and reposts with the 605
 * line replaced by a line on `targetAccountId`. Inserts a
 * TRUST_NON_TRUST_RECATEGORIZED audit on each new JE; dismisses findings.
 *
 * No typeTag stamping — unlike the loan-payment "Not a Loan" path, there's
 * no "vehicle vendor" classification on the contact to invert.
 */
export async function recategorizeContactVehicleExpense(args: {
	findingIds: string[];
	targetAccountId: string;
}): Promise<RecategorizeContactVehicleExpenseResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}

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
	if (!target) {
		return { ok: false, processed: 0, failed: [], error: 'Target account not in this organization' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const ok = await recategorizeOneFinding({
				orgId,
				userId,
				findingId,
				target,
			});
			if (ok.ok) processed += 1;
			else failed.push({ findingId, error: ok.error ?? 'Failed' });
		} catch (err) {
			failed.push({
				findingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}

async function recategorizeOneFinding(args: {
	orgId: string;
	userId: string | null;
	findingId: string;
	target: { id: string; accountNumber: string | null; accountName: string };
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { orgId, userId, findingId, target } = args;

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE') {
		return { ok: false, error: `recategorizeContactVehicleExpense doesn't apply to ${finding.code}` };
	}

	// Find the 605-class line on this JE (detail_type='auto').
	const sourceLineRows = await db
		.select({
			accountId: journalEntryLines.accountId,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLines.journalEntryId, finding.journalEntryId),
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'auto'),
			),
		)
		.limit(1);
	const sourceLineSummary = sourceLineRows[0];
	if (!sourceLineSummary) {
		return { ok: false, error: 'No 605 (auto) line on this JE' };
	}
	const sourceAccountId = sourceLineSummary.accountId;

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
	const sourceLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching 605 line on this JE' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);

	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 605 line recategorized to ${target.accountNumber ?? ''} ${target.accountName} (not a vehicle expense)`,
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
				message: `Moved from ${sourceLineSummary.accountNumber ?? ''} ${sourceLineSummary.accountName} to ${target.accountNumber ?? ''} ${target.accountName} — not a vehicle expense.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: sourceAccountId,
					fromAccountNumber: sourceLineSummary.accountNumber,
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
					dismissedNote: `Auto-dismissed: recategorized to ${target.accountNumber ?? ''} ${target.accountName} — not a vehicle expense.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize' };
	}

	return { ok: true };
}
