'use server';

import { revalidatePath } from 'next/cache';
import { reroute815ToTrustee } from './reroute815ToTrustee';
import type { Bulk710Result } from './bulk710AssignBeneficiary';

/**
 * Bulk-apply the 815 Trustee action across a set of findings. 815-only
 * (the 820 codes are not in TRUST_815_TRUSTEE_ACTIONABLE_CODES); the per-
 * action call still validates the code so a 820 id slipping in here would
 * fail per-finding rather than corrupt anything.
 *
 * Same per-finding error-isolation contract as the 710 bulks.
 */
export async function bulk815AssignTrustee(args: {
	findingIds: string[];
	contactIds: string[];
}): Promise<Bulk710Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (args.contactIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No trustees selected' };
	}
	if (args.contactIds.length > 1) {
		return {
			ok: false,
			processed: 0,
			failed: [],
			error: 'Bulk split across multiple trustees is not supported for 815 — pick one.',
		};
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await reroute815ToTrustee({
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
