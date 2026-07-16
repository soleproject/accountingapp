'use server';

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { createJournalEntry } from '@/lib/accounting/posting';
import { syncLoanWithGL } from '@/lib/loans/sync';

const Schema = z.object({
	loanId: z.string().min(1),
	scheduleRowId: z.string().min(1),
	bankAccountId: z.string().min(1),
	paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface RecordLoanPaymentResult {
	ok: boolean;
	error?: string;
	journalEntryId?: string;
}

/**
 * Post a loan payment for a specific schedule row. Builds a balanced JE
 * with the scheduled P/I split, links the JE to the row via
 * `posted_journal_entry_id`, and decrements the loan's current_principal.
 *
 * v1: actual amount == scheduled amount. A future slice will let the user
 * override (e.g. for early-payoff catch-up) and surface a "partial" /
 * "over" indicator on the row.
 */
export async function recordLoanPayment(args: {
	loanId: string;
	scheduleRowId: string;
	bankAccountId: string;
	paymentDate: string;
}): Promise<RecordLoanPaymentResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	// Reconcile against the GL before any branch on posted-state. Cheap
	// when nothing's stale; idempotent when it is.
	await syncLoanWithGL({ orgId, loanId: parsed.data.loanId });

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
		.where(eq(loans.id, parsed.data.loanId))
		.limit(1);
	if (!loan) return { ok: false, error: 'Loan not found' };
	if (loan.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (!loan.interestExpenseAccountId) {
		return { ok: false, error: 'Loan has no interest expense account configured' };
	}

	const [row] = await db
		.select({
			id: loanAmortizationSchedules.id,
			loanId: loanAmortizationSchedules.loanId,
			paymentNumber: loanAmortizationSchedules.paymentNumber,
			dueDate: loanAmortizationSchedules.dueDate,
			principalAmount: loanAmortizationSchedules.principalAmount,
			interestAmount: loanAmortizationSchedules.interestAmount,
			remainingBalance: loanAmortizationSchedules.remainingBalance,
			postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
		})
		.from(loanAmortizationSchedules)
		.where(eq(loanAmortizationSchedules.id, parsed.data.scheduleRowId))
		.limit(1);
	if (!row) return { ok: false, error: 'Schedule row not found' };
	if (row.loanId !== loan.id) return { ok: false, error: 'Schedule row does not belong to this loan' };
	if (row.postedJournalEntryId) return { ok: false, error: 'This payment has already been recorded' };

	// Bank account must belong to this org and be a bank-type account.
	const [bank] = await db
		.select({ id: chartOfAccounts.id, accountType: chartOfAccounts.accountType })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, parsed.data.bankAccountId),
				eq(chartOfAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!bank) return { ok: false, error: 'Bank account not in this organization' };
	if (bank.accountType !== 'bank') {
		return { ok: false, error: 'Selected account is not a bank account' };
	}

	const principal = Number(row.principalAmount);
	const interest = Number(row.interestAmount);
	const total = Math.round((principal + interest) * 100) / 100;

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			const newJe = await createJournalEntry(
				{
					organizationId: orgId,
					date: parsed.data.paymentDate,
					memo: `Loan payment #${row.paymentNumber} — ${loan.displayName}`,
					posted: true,
					sourceType: 'loan_payment',
					sourceId: row.id,
					lines: [
						{
							accountId: loan.liabilityAccountId,
							debit: principal,
							credit: 0,
						},
						{
							accountId: loan.interestExpenseAccountId!,
							debit: interest,
							credit: 0,
						},
						{
							accountId: parsed.data.bankAccountId,
							debit: 0,
							credit: total,
						},
					],
				},
				tx,
			);
			newJeId = newJe.id;

			await tx
				.update(loanAmortizationSchedules)
				.set({
					postedJournalEntryId: newJe.id,
					postedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(loanAmortizationSchedules.id, row.id));

			const newPrincipal = Math.max(0, Number(loan.currentPrincipal) - principal);
			const remainingUnposted = await tx
				.select({ n: sql<number>`count(*)::int` })
				.from(loanAmortizationSchedules)
				.where(
					and(
						eq(loanAmortizationSchedules.loanId, loan.id),
						isNull(loanAmortizationSchedules.postedJournalEntryId),
					),
				);
			const updates: Record<string, unknown> = {
				currentPrincipal: String(newPrincipal),
				updatedAt: new Date().toISOString(),
			};
			if ((remainingUnposted[0]?.n ?? 0) === 0) {
				updates.status = 'paid_off';
			}
			await tx.update(loans).set(updates).where(eq(loans.id, loan.id));

			// Silence "isNotNull is imported but unused" if a future refactor
			// drops the only call site.
			void isNotNull;
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to post payment' };
	}

	revalidatePath('/loans');
	revalidatePath(`/loans/${loan.id}`);
	return { ok: true, journalEntryId: newJeId! };
}
