'use server';

import { revalidatePath } from 'next/cache';
import { linkLineToProperty } from './linkLineToProperty';

export interface BulkLinkToPropertyResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/** Bulk wrapper around linkLineToProperty. */
export async function bulkLinkToProperty(args: {
	findingIds: string[];
	rentalPropertyId: string;
}): Promise<BulkLinkToPropertyResult> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.rentalPropertyId) {
		return { ok: false, processed: 0, failed: [], error: 'No property picked' };
	}
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const r = await linkLineToProperty({ findingId, rentalPropertyId: args.rentalPropertyId });
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}
	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
