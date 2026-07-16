'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { fixedAssets } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	assetId: z.string().min(1),
	// Always-editable fields. Don't touch anything that would change the
	// asset's GL footprint — those edits require a draft asset or a
	// reverse-and-re-register flow we'll wire later.
	name: z.string().min(1).max(200),
	assetNumber: z.string().max(50).optional().or(z.literal('')),
	serialNumber: z.string().max(100).optional().or(z.literal('')),
	location: z.string().max(200).optional().or(z.literal('')),
	notes: z.string().max(2000).optional().or(z.literal('')),
	autoDepreciate: z.boolean(),
});

export interface UpdateAssetResult {
	ok: boolean;
	error?: string;
}

/**
 * Edit the "safe" fields of a fixed asset — display metadata + the
 * per-asset auto-depreciate toggle. Financial fields (cost basis,
 * method, useful life) are intentionally NOT in this action: changing
 * them would invalidate the beginning-balance JE + every depreciation
 * run since. Those edits require disposing + re-registering.
 *
 * Disposed assets are immutable — caller must reject before invoking
 * this from the UI, but we double-check here as defense in depth.
 */
export async function updateAsset(args: {
	assetId: string;
	name: string;
	assetNumber?: string;
	serialNumber?: string;
	location?: string;
	notes?: string;
	autoDepreciate: boolean;
}): Promise<UpdateAssetResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	const [existing] = await db
		.select({ id: fixedAssets.id, status: fixedAssets.status })
		.from(fixedAssets)
		.where(
			and(
				eq(fixedAssets.id, parsed.data.assetId),
				eq(fixedAssets.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Asset not in this organization' };
	if (existing.status === 'disposed') {
		return { ok: false, error: 'Disposed assets are immutable' };
	}

	await db
		.update(fixedAssets)
		.set({
			name: parsed.data.name,
			assetNumber: parsed.data.assetNumber?.trim() || null,
			serialNumber: parsed.data.serialNumber?.trim() || null,
			location: parsed.data.location?.trim() || null,
			notes: parsed.data.notes?.trim() || null,
			autoDepreciate: parsed.data.autoDepreciate,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(fixedAssets.id, parsed.data.assetId));

	revalidatePath('/assets');
	revalidatePath(`/assets/${parsed.data.assetId}`);
	return { ok: true };
}
