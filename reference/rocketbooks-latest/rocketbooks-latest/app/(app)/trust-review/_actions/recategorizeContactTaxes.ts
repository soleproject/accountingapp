'use server';

import { revalidatePath } from 'next/cache';
import { recategorizeTaxes } from './recategorizeTaxes';

export interface RecategorizeContactTaxesResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk wrapper around recategorizeTaxes for the
 * TRUST_505_705_LIKELY_MISROUTED finding. Loops the existing
 * single-finding action per id; one-click → 505 or → 705.
 */
export async function recategorizeContactTaxes(args: {
	findingIds: string[];
	target: 'property' | 'non_property';
}): Promise<RecategorizeContactTaxesResult> {
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
			failed.push({
				findingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
