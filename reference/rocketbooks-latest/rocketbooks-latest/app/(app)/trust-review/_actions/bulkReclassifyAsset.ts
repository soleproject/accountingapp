'use server';

import { revalidatePath } from 'next/cache';
import { reclassifyAssetToExpense } from './reclassifyAssetToExpense';
import type { BulkResult } from './bulkRerouteNoReceipt';

/**
 * Bulk-reclassify every selected TRUST_ASSET_REPOST_REVIEW finding off
 * its asset account onto a single expense account.
 */
export async function bulkReclassifyAsset(args: {
	findingIds: string[];
	expenseAccountId: string;
}): Promise<BulkResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.expenseAccountId) {
		return { ok: false, processed: 0, failed: [], error: 'Pick an expense account first' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await reclassifyAssetToExpense({
				findingId,
				expenseAccountId: args.expenseAccountId,
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
