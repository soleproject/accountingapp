'use server';

import { revalidatePath } from 'next/cache';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { assetSettings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	cronEnabled: z.boolean(),
	defaultAutoDepreciate: z.boolean(),
});

export interface UpdateAssetSettingsResult {
	ok: boolean;
	error?: string;
}

/**
 * Upsert the per-org asset settings row.
 *
 *   cron_enabled            — when true, the monthly cron picks up THIS
 *                             org and runs depreciation against assets
 *                             flagged auto_depreciate. Off by default —
 *                             trustees opt in.
 *   default_auto_depreciate — initial value for new assets' per-asset
 *                             toggle. Convenience so a trustee who
 *                             wants everything on autopilot doesn't
 *                             have to check the box on every asset.
 *
 * Per-asset toggles still win at run time; this is just the default for
 * new assets.
 */
export async function updateAssetSettings(args: {
	cronEnabled: boolean;
	defaultAutoDepreciate: boolean;
}): Promise<UpdateAssetSettingsResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	// Upsert: insert if missing, update if present. Postgres ON CONFLICT
	// keyed by organization_id (the table's primary key).
	await db
		.insert(assetSettings)
		.values({
			organizationId: orgId,
			cronEnabled: parsed.data.cronEnabled,
			defaultAutoDepreciate: parsed.data.defaultAutoDepreciate,
		})
		.onConflictDoUpdate({
			target: assetSettings.organizationId,
			set: {
				cronEnabled: parsed.data.cronEnabled,
				defaultAutoDepreciate: parsed.data.defaultAutoDepreciate,
				updatedAt: sql`now()`,
			},
		});

	revalidatePath('/assets');
	return { ok: true };
}
