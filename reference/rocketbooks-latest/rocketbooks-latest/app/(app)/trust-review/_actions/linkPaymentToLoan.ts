'use server';

import { randomUUID } from 'crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	loanAmortizationSchedules,
	loans,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { syncLoanWithGL } from '@/lib/loans/sync';

export interface LinkPaymentToLoanResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve a TRUST_DEFERRED_LOAN_SPLIT_NEEDED finding by linking the
 * undifferentiated 250 Notes Payable JE to a specific loan +
 * amortization-schedule row.
 *
 * The original JE typically looks like: Dr 250 Notes Payable for the
 * full payment amount, Cr Bank. We reverse it and repost as the proper
 * 3-line entry: Dr 250.x liability (principal portion), Dr 500 Interest
 * Expense (interest portion), Cr Bank (full amount). Schedule row gets
 * marked posted, loan's current_principal decrements.
 *
 * When scheduleRowId is omitted, the action picks the loan's next
 * unposted row.
 */
export async function linkPaymentToLoan(args: {
	findingId: string;
	loanId: string;
	scheduleRowId?: string;
}): Promise<LinkPaymentToLoanResult> {
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
	if (finding.code !== 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED') {
		return { ok: false, error: 'linkPaymentToLoan only applies to LOAN_SPLIT_NEEDED findings' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };

	// Sync the loan's GL state before branching on posted-count.
	await syncLoanWithGL({ orgId, loanId: args.loanId });

	const [loan] = await db
		.select({
			id: loans.id,
			organizationId: loans.organizationId,
			displayName: loans.displayName,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
			currentPrincipal: loans.currentPrincipal,
		})
		.from(loans)
		.where(eq(loans.id, args.loanId))
		.limit(1);
	if (!loan) return { ok: false, error: 'Loan not found' };
	if (loan.organizationId !== orgId) return { ok: false, error: 'Loan not in this organization' };
	if (!loan.interestExpenseAccountId) {
		return { ok: false, error: 'Loan has no interest expense account configured' };
	}

	// Pick schedule row (explicit or next unposted).
	let row;
	if (args.scheduleRowId) {
		[row] = await db
			.select({
				id: loanAmortizationSchedules.id,
				paymentNumber: loanAmortizationSchedules.paymentNumber,
				dueDate: loanAmortizationSchedules.dueDate,
				principalAmount: loanAmortizationSchedules.principalAmount,
				interestAmount: loanAmortizationSchedules.interestAmount,
				postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
			})
			.from(loanAmortizationSchedules)
			.where(eq(loanAmortizationSchedules.id, args.scheduleRowId))
			.limit(1);
		if (!row || row.id !== args.scheduleRowId) return { ok: false, error: 'Schedule row not found' };
		if (row.postedJournalEntryId) return { ok: false, error: 'That schedule row is already posted' };
	} else {
		[row] = await db
			.select({
				id: loanAmortizationSchedules.id,
				paymentNumber: loanAmortizationSchedules.paymentNumber,
				dueDate: loanAmortizationSchedules.dueDate,
				principalAmount: loanAmortizationSchedules.principalAmount,
				interestAmount: loanAmortizationSchedules.interestAmount,
				postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
			})
			.from(loanAmortizationSchedules)
			.where(
				and(
					eq(loanAmortizationSchedules.loanId, loan.id),
					isNull(loanAmortizationSchedules.postedJournalEntryId),
				),
			)
			.orderBy(asc(loanAmortizationSchedules.paymentNumber))
			.limit(1);
		if (!row) return { ok: false, error: 'Loan has no unposted schedule rows' };
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

	// Find the bank-side credit line on the existing JE so the new
	// 3-line entry can debit/credit the same bank account.
	const lineRows = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			accountType: chartOfAccounts.accountType,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(eq(journalEntryLines.journalEntryId, je.id));
	const bankLine = lineRows.find(
		(l) => l.accountType === 'bank' && Number(l.credit ?? 0) > 0,
	);
	if (!bankLine) {
		return { ok: false, error: 'No bank credit line on this JE — cannot derive the source bank account' };
	}

	const principal = Number(row.principalAmount);
	const interest = Number(row.interestAmount);
	const total = Math.round((principal + interest) * 100) / 100;

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — loan payment #${row.paymentNumber} for ${loan.displayName} reposted with P/I split`,
				},
				tx,
			);

			const newJe = await createJournalEntry(
				{
					organizationId: orgId,
					date: je.date,
					memo: `Loan payment #${row.paymentNumber} — ${loan.displayName}`,
					posted: true,
					sourceType: 'loan_payment',
					sourceId: row.id,
					lines: [
						{ accountId: loan.liabilityAccountId, debit: principal, credit: 0 },
						{ accountId: loan.interestExpenseAccountId!, debit: interest, credit: 0 },
						{ accountId: bankLine.accountId, debit: 0, credit: total },
					],
				},
				tx,
			);
			newJeId = newJe.id;

			// Re-point the source transaction at the new JE so future
			// categorize edits operate on the correct entry.
			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: loan.liabilityAccountId })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			// Mark the schedule row posted; decrement current_principal.
			await tx
				.update(loanAmortizationSchedules)
				.set({
					postedJournalEntryId: newJe.id,
					postedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(loanAmortizationSchedules.id, row.id));
			const newPrincipal = Math.max(0, Number(loan.currentPrincipal) - principal);
			await tx
				.update(loans)
				.set({
					currentPrincipal: String(newPrincipal),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(loans.id, loan.id));

			// Decisioned audit.
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: newJe.id,
				code: 'TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE',
				severity: 'warn',
				message: `Linked to ${loan.displayName} payment #${row.paymentNumber} (due ${row.dueDate}) — principal $${principal.toFixed(2)} / interest $${interest.toFixed(2)}.`,
				metadata: {
					loanId: loan.id,
					scheduleRowId: row.id,
					paymentNumber: row.paymentNumber,
					principal,
					interest,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: linked to ${loan.displayName} payment #${row.paymentNumber}. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to link payment to loan' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/loans');
	revalidatePath(`/loans/${loan.id}`);
	return { ok: true, newJournalEntryId: newJeId! };
}
