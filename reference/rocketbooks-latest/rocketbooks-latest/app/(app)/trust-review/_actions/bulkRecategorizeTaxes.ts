'use server';

import { revalidatePath } from 'next/cache';
import { recategorizeTaxes, type TaxTarget } from './recategorizeTaxes';
import type { BulkResult } from './bulkRerouteNoReceipt';

/**
 * Bulk-flip every selected TRUST_505_705_LIKELY_MISROUTED finding to
 * a single tax-direction. Rows already on the requested target return
 * "already on the requested tax account" — counted as failures so the
 * user sees the count.
 */
export async function bulkRecategorizeTaxes(args: {
	findingIds: string[];
	target: TaxTarget;
}): Promise<BulkResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await recategorizeTaxes({ findingId, target: args.target });
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}

	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
