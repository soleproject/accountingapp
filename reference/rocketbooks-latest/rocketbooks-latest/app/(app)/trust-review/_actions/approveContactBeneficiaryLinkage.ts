'use server';

import { revalidatePath } from 'next/cache';
import { tagFindingBeneficiary } from './tagFindingBeneficiary';

export interface ApproveContactBeneficiaryLinkageResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk wrapper around tagFindingBeneficiary for the
 * TRUST_BENEFICIARY_LINKAGE_REQUIRED and TRUST_635_RECIPIENT_REQUIRED
 * findings. The underlying action already handles the JE line tag, the
 * audit insertion (TRUST_BENEFICIARY_TAGGED / TRUST_635_RECIPIENT_TAGGED
 * via the TAG_AUDIT_CODE_BY_ORIGIN map), and the dismiss — we just loop
 * per finding so a single bad JE surfaces in `failed` without aborting
 * the rest.
 */
export async function approveContactBeneficiaryLinkage(args: {
	contactId?: string | null;
	findingIds: string[];
	beneficiaryId: string;
}): Promise<ApproveContactBeneficiaryLinkageResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.beneficiaryId) {
		return { ok: false, processed: 0, failed: [], error: 'No beneficiary picked' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const r = await tagFindingBeneficiary({
				findingId,
				beneficiaryId: args.beneficiaryId,
			});
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
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
