'use server';

import { revalidatePath } from 'next/cache';
import {
	addContactTypeTag,
	VENDOR_TYPE_TAG_LOAN,
} from '@/lib/accounting/vendor-classification';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { linkPaymentToLoan } from './linkPaymentToLoan';

export interface ApproveContactLoanPaymentResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk "Approve" for a TRUST_DEFERRED_LOAN_SPLIT_NEEDED
 * sub-group: stamps the 'loan_vendor' typeTag on the contact (so future
 * 250 postings from this vendor auto-bucket as loans), then loops
 * linkPaymentToLoan for every selected finding against the supplied loan.
 *
 * Sequential per finding — linkPaymentToLoan reverses + reposts each JE
 * with the proper P/I/bank split, advances the loan's next-unposted
 * schedule row, and dismisses the finding. If a JE was already linked to
 * a different loan, the existing reverse + repost mechanism transparently
 * re-links it.
 */
export async function approveContactLoanPayment(args: {
	/** Source contact for the 'loan_vendor' typeTag stamp. Null when
	 *  called from the toolbar across multiple contacts — the stamp is
	 *  skipped but linkPaymentToLoan still runs per finding. */
	contactId?: string | null;
	findingIds: string[];
	loanId: string;
}): Promise<ApproveContactLoanPaymentResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.loanId) {
		return { ok: false, processed: 0, failed: [], error: 'No loan picked' };
	}

	if (args.contactId) {
		await addContactTypeTag({
			organizationId: orgId,
			contactId: args.contactId,
			tag: VENDOR_TYPE_TAG_LOAN,
		});
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await linkPaymentToLoan({ findingId, loanId: args.loanId });
			if (!r.ok) {
				failed.push({ findingId, error: r.error ?? 'Failed' });
			} else {
				processed += 1;
			}
		} catch (err) {
			failed.push({
				findingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	revalidatePath('/trust-review');
	revalidatePath('/loans');
	revalidatePath(`/loans/${args.loanId}`);
	return { ok: failed.length === 0, processed, failed };
}
