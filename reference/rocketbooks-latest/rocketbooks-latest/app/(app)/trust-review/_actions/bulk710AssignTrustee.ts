'use server';

import { revalidatePath } from 'next/cache';
import { tagFindingTrusteeContact } from './tagFindingTrusteeContact';
import { split710ByTrustees } from './split710ByTrustees';
import type { Bulk710Result } from './bulk710AssignBeneficiary';

/**
 * Bulk-apply the 710 Trustee action across a set of findings. Mirror of
 * bulk710AssignBeneficiary for the trustee path:
 *
 *   contactIds.length === 1  → set each finding's 710 line contact to
 *                              that trustee (tagFindingTrusteeContact)
 *   contactIds.length  >= 2  → split each finding's 710 line evenly
 *                              across those trustees (split710ByTrustees)
 *
 * Same per-finding error-isolation contract as the beneficiary bulk
 * action.
 */
export async function bulk710AssignTrustee(args: {
	findingIds: string[];
	contactIds: string[];
}): Promise<Bulk710Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (args.contactIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No trustees selected' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	const isSplit = args.contactIds.length > 1;

	for (const findingId of args.findingIds) {
		try {
			const r = isSplit
				? await split710ByTrustees({
						findingId,
						contactIds: args.contactIds,
					})
				: await tagFindingTrusteeContact({
						findingId,
						contactId: args.contactIds[0],
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
