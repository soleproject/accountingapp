'use server';

import { revalidatePath } from 'next/cache';
import { reclassify450To455 } from './reclassify450To455';

export interface BulkReclassify450Result {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk wrapper around reclassify450ToK1 for the
 * TRUST_450_BUSINESS_INCOME_BLOCKED finding. Loops the existing
 * single-finding action.
 */
export async function bulkReclassify450(args: {
	findingIds: string[];
}): Promise<BulkReclassify450Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const r = await reclassify450To455({ findingId });
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
