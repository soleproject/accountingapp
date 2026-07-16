'use server';

import { revalidatePath } from 'next/cache';
import { recategorizeNonTrust } from './recategorizeNonTrust';
import type { BulkResult } from './bulkRerouteNoReceipt';

/**
 * Bulk-recategorize every selected TRUST_NON_TRUST_CATEGORY_USED finding
 * to a single target account. Per-finding errors collected, never aborts
 * the loop.
 */
export async function bulkRecategorizeNonTrust(args: {
	findingIds: string[];
	targetAccountId: string;
}): Promise<BulkResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.targetAccountId) {
		return { ok: false, processed: 0, failed: [], error: 'Pick an account first' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await recategorizeNonTrust({
				findingId,
				targetAccountId: args.targetAccountId,
			});
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}

	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
