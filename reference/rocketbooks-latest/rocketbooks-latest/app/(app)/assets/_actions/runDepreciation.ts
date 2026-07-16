'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import {
	runAssetDepreciationCore,
	type RunAssetDepreciationCoreResult,
} from '@/lib/accounting/run-asset-depreciation';

const Schema = z.object({
	periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	bookType: z.enum(['fiduciary', 'tax']).default('fiduciary'),
	triggeredBy: z.enum(['manual', 'cron']).default('manual'),
});

export type RunDepreciationResult = RunAssetDepreciationCoreResult;

/**
 * User-facing wrapper around runAssetDepreciationCore. Resolves the org
 * from session and runs against ALL active assets (manual-run semantics
 * — operator confirmed they want the period posted for every eligible
 * asset, not just the auto-flagged ones).
 *
 * The cron path uses runAssetDepreciationCore directly with
 * scope: 'auto_only'.
 */
export async function runDepreciation(args: {
	periodEndDate: string;
	bookType?: 'fiduciary' | 'tax';
	triggeredBy?: 'manual' | 'cron';
}): Promise<RunDepreciationResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	const result = await runAssetDepreciationCore({
		organizationId: orgId,
		periodEndDate: parsed.data.periodEndDate,
		bookType: parsed.data.bookType,
		triggeredBy: parsed.data.triggeredBy,
		triggeredByUserId: parsed.data.triggeredBy === 'manual' ? userId : null,
		scope: 'all_active',
	});

	revalidatePath('/assets');
	return result;
}
