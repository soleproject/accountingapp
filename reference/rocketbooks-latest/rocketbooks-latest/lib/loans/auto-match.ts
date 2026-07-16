import 'server-only';
import { randomUUID } from 'crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	loanAmortizationSchedules,
	loans,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { syncLoanWithGL } from './sync';

/** Amount tolerance for matching a bank payment to a scheduled row,
 *  in dollars. ± $0.01 covers rounding without admitting genuinely
 *  different payments. */
const AMOUNT_TOLERANCE_DOLLARS = 0.01;

/** Date window (± days from scheduled due_date) for accepting a bank
 *  payment as the schedule row's payment. Lenders typically post 1-3
 *  days off the due date; ±5 gives weekends + holidays room without
 *  letting an entirely off-cycle payment match. */
const DATE_WINDOW_DAYS = 5;

export interface AutoMatchResult {
	matched: boolean;
	loanId?: string;
	scheduleRowId?: string;
	newJournalEntryId?: string;
	reason?: string;
}

/**
 * Hook called after categorize creates a JE: if the categorized line
 * landed on a loan's liability account AND the JE amount + date match
 * the loan's next unposted schedule row within tolerance, automatically
 * reverse the simple categorize JE and repost as the proper 3-line
 * P/I/bank entry (same shape as recordLoanPayment / linkPaymentToLoan).
 *
 * On match: drops a TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE audit on the
 * new JE so the user can see in Trust Review's Decisioned tab what
 * auto-matched. The eventual TRUST_DEFERRED_LOAN_SPLIT_NEEDED finding
 * never gets a chance to fire on the new JE because the line is now
 * split across 250.x + 500 + bank rather than sitting raw on
 * notes_payable.
 *
 * On no-match (no loan, amount drift, date drift, no unposted row, etc.):
 * does nothing. The original simple JE stays; the rules engine's
 * LOAN_SPLIT_NEEDED finding fires and the user can resolve manually via
 * the per-row Link to loan picker.
 */
export async function maybeAutoLinkLoanPayment(args: {
	organizationId: string;
	journalEntryId: string;
	transactionId: string;
	transactionAmount: number;
	transactionDate: string;
	bankAccountId: string;
	categoryAccountId: string;
}): Promise<AutoMatchResult> {
	// Is the categorized account the liability account of an active loan?
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
		.where(
			and(
				eq(loans.organizationId, args.organizationId),
				eq(loans.liabilityAccountId, args.categoryAccountId),
				eq(loans.status, 'active'),
			),
		)
		.limit(1);
	if (!loan) return { matched: false, reason: 'No active loan on this liability account' };
	if (!loan.interestExpenseAccountId) {
		return { matched: false, reason: 'Loan has no interest expense account configured' };
	}

	// Sync GL state first so externally-reversed JEs don't keep stale
	// rows marked posted.
	await syncLoanWithGL({ orgId: args.organizationId, loanId: loan.id });

	// Find the next unposted schedule row.
	const [row] = await db
		.select({
			id: loanAmortizationSchedules.id,
			paymentNumber: loanAmortizationSchedules.paymentNumber,
			dueDate: loanAmortizationSchedules.dueDate,
			principalAmount: loanAmortizationSchedules.principalAmount,
			interestAmount: loanAmortizationSchedules.interestAmount,
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
	if (!row) return { matched: false, reason: 'No unposted schedule rows on this loan' };

	const principal = Number(row.principalAmount);
	const interest = Number(row.interestAmount);
	const scheduledTotal = Math.round((principal + interest) * 100) / 100;
	const amountDrift = Math.abs(args.transactionAmount - scheduledTotal);
	if (amountDrift > AMOUNT_TOLERANCE_DOLLARS) {
		return {
			matched: false,
			reason: `Amount $${args.transactionAmount.toFixed(2)} doesn't match scheduled $${scheduledTotal.toFixed(2)} (drift $${amountDrift.toFixed(2)})`,
		};
	}

	const dateDrift = Math.abs(daysBetween(args.transactionDate, row.dueDate));
	if (dateDrift > DATE_WINDOW_DAYS) {
		return {
			matched: false,
			reason: `Date ${args.transactionDate} is ${dateDrift} days off scheduled ${row.dueDate} (window ±${DATE_WINDOW_DAYS})`,
		};
	}

	// Match! Reverse the simple categorize JE, post the proper 3-line entry.
	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: args.organizationId,
					journalEntryId: args.journalEntryId,
					reversalMemo: `Reversal — auto-matched to ${loan.displayName} payment #${row.paymentNumber}`,
				},
				tx,
			);

			const newJe = await createJournalEntry(
				{
					organizationId: args.organizationId,
					date: args.transactionDate,
					memo: `Loan payment #${row.paymentNumber} — ${loan.displayName}`,
					posted: true,
					sourceType: 'loan_payment',
					sourceId: row.id,
					lines: [
						{ accountId: loan.liabilityAccountId, debit: principal, credit: 0 },
						{ accountId: loan.interestExpenseAccountId!, debit: interest, credit: 0 },
						{ accountId: args.bankAccountId, debit: 0, credit: scheduledTotal },
					],
				},
				tx,
			);
			newJeId = newJe.id;

			// Re-point the source transaction at the new JE; categoryAccountId
			// stays on the liability account (it's the largest debit / the
			// canonical category for this txn).
			await tx
				.update(transactions)
				.set({ journalEntryId: newJe.id, categoryAccountId: loan.liabilityAccountId })
				.where(
					and(
						eq(transactions.id, args.transactionId),
						eq(transactions.organizationId, args.organizationId),
					),
				);

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

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: args.organizationId,
				journalEntryId: newJe.id,
				code: 'TRUST_LOAN_PAYMENT_LINKED_TO_SCHEDULE',
				severity: 'warn',
				message: `Auto-matched to ${loan.displayName} payment #${row.paymentNumber} (due ${row.dueDate}) — principal $${principal.toFixed(2)} / interest $${interest.toFixed(2)}. Bank-feed amount + date matched the schedule within tolerance.`,
				metadata: {
					loanId: loan.id,
					scheduleRowId: row.id,
					paymentNumber: row.paymentNumber,
					principal,
					interest,
					autoMatched: true,
					amountDrift,
					dateDrift,
				},
			});
		});
	} catch (err) {
		return { matched: false, reason: err instanceof Error ? err.message : 'Auto-match failed' };
	}

	return {
		matched: true,
		loanId: loan.id,
		scheduleRowId: row.id,
		newJournalEntryId: newJeId!,
	};
}

function daysBetween(a: string, b: string): number {
	const [ay, am, ad] = a.split('-').map(Number);
	const [by, bm, bd] = b.split('-').map(Number);
	const dt1 = Date.UTC(ay, am - 1, ad);
	const dt2 = Date.UTC(by, bm - 1, bd);
	return Math.round((dt1 - dt2) / 86400000);
}
