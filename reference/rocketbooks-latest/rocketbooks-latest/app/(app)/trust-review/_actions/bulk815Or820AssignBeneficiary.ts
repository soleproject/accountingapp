'use server';

import { revalidatePath } from 'next/cache';
import { reassign815Or820Beneficiary } from './reassign815Or820Beneficiary';
import type { Bulk710Result } from './bulk710AssignBeneficiary';

/**
 * Bulk-apply the 815/820 Beneficiary action across a set of findings.
 * Mirrors bulk710AssignBeneficiary's shape — sequential loop with per-
 * finding error isolation, one revalidatePath at the end. Split-evenly
 * is not yet supported on the 815/820 family (single-pick only).
 */
export async function bulk815Or820AssignBeneficiary(args: {
	findingIds: string[];
	beneficiaryIds: string[];
}): Promise<Bulk710Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (args.beneficiaryIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No beneficiaries selected' };
	}
	if (args.beneficiaryIds.length > 1) {
		return {
			ok: false,
			processed: 0,
			failed: [],
			error: 'Bulk split across multiple beneficiaries is not supported for 815/820 — pick one.',
		};
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await reassign815Or820Beneficiary({
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
