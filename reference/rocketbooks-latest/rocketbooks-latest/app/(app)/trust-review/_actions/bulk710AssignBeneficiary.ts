'use server';

import { revalidatePath } from 'next/cache';
import { reroute710ToBeneficiary } from './reroute710ToBeneficiary';
import { split710ByBeneficiaries } from './split710ByBeneficiaries';

export interface Bulk710Result {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Bulk-apply the 710 Beneficiary action across a set of findings. Mirrors
 * the per-row behavior:
 *
 *   beneficiaryIds.length === 1  → reroute each selected finding's 710
 *                                  line to that beneficiary's correct
 *                                  account (815 if qualifying, 26x if
 *                                  not) via reroute710ToBeneficiary
 *   beneficiaryIds.length  >= 2  → split each selected finding's 710
 *                                  line evenly + reroute each split to
 *                                  the matching beneficiary's target
 *                                  account (split710ByBeneficiaries)
 *
 * Loops sequentially so a per-finding failure surfaces in `failed` without
 * aborting the rest. revalidatePath fires once at the end. For very large
 * selections this is N round-trips; acceptable up to hundreds of findings
 * and we can batch later if needed.
 */
export async function bulk710AssignBeneficiary(args: {
	findingIds: string[];
	beneficiaryIds: string[];
}): Promise<Bulk710Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (args.beneficiaryIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No beneficiaries selected' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	const isSplit = args.beneficiaryIds.length > 1;

	for (const findingId of args.findingIds) {
		try {
			const r = isSplit
				? await split710ByBeneficiaries({
						findingId,
						beneficiaryIds: args.beneficiaryIds,
					})
				: await reroute710ToBeneficiary({
						findingId,
						beneficiaryId: args.beneficiaryIds[0],
					});
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
	return { ok: failed.length === 0, processed, failed };
}
