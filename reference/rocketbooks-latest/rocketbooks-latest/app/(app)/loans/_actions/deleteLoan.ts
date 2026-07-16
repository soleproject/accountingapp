'use server';

import { and, eq, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { loanAmortizationSchedules, loans } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { syncLoanWithGL } from '@/lib/loans/sync';

export interface DeleteLoanResult {
	ok: boolean;
	error?: string;
}

/**
 * Hard-delete a loan + its schedule rows. Only allowed when zero
 * payments are posted (after the GL sync, so externally-reversed JEs
 * don't keep the loan stuck).
 *
 * Schedule rows go via ON DELETE CASCADE.
 */
export async function deleteLoan(args: { loanId: string }): Promise<DeleteLoanResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	if (!args.loanId) return { ok: false, error: 'Missing loanId' };

	await syncLoanWithGL({ orgId, loanId: args.loanId });

	const [loan] = await db
		.select({ id: loans.id, organizationId: loans.organizationId })
		.from(loans)
		.where(eq(loans.id, args.loanId))
		.limit(1);
	if (!loan) return { ok: false, error: 'Loan not found' };
	if (loan.organizationId !== orgId) return { ok: false, error: 'Not authorized' };

	const [postedRow] = await db
		.select({ id: loanAmortizationSchedules.id })
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, args.loanId),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		)
		.limit(1);
	if (postedRow) {
		return {
			ok: false,
			error: 'Cannot delete a loan with posted payments. Reverse the payment JEs first, then try again.',
		};
	}

	await db.delete(loans).where(eq(loans.id, args.loanId));

	revalidatePath('/loans');
	redirect('/loans');
}
