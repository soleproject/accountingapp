'use server';

import { revalidatePath } from 'next/cache';
import { apply310ToDemandNote } from './apply310ToDemandNote';
import { queueK1Draft } from './queueK1Draft';

export interface Bulk310Result {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/** Bulk wrapper around apply310ToDemandNote. */
export async function bulkApply310ToDemandNote(args: {
	findingIds: string[];
}): Promise<Bulk310Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const r = await apply310ToDemandNote({ findingId });
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}
	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}

/** Bulk wrapper around queueK1Draft. */
export async function bulkQueueK1(args: {
	findingIds: string[];
}): Promise<Bulk310Result> {
	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const r = await queueK1Draft({ findingId });
			if (!r.ok) failed.push({ findingId, error: r.error ?? 'Failed' });
			else processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}
	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
