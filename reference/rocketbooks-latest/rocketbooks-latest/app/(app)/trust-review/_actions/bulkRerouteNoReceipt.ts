'use server';

import { revalidatePath } from 'next/cache';
import { rerouteNoReceiptToDemandNote } from './rerouteNoReceiptToDemandNote';

export interface BulkResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Bulk-reroute every selected TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION
 * finding to a single beneficiary's demand note. Loops sequentially so a
 * per-finding failure surfaces in `failed` without aborting the rest;
 * revalidatePath fires once at the end.
 */
export async function bulkRerouteNoReceipt(args: {
	findingIds: string[];
	beneficiaryId: string;
}): Promise<BulkResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.beneficiaryId) {
		return { ok: false, processed: 0, failed: [], error: 'Pick a beneficiary first' };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const r = await rerouteNoReceiptToDemandNote({
				findingId,
				beneficiaryId: args.beneficiaryId,
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
