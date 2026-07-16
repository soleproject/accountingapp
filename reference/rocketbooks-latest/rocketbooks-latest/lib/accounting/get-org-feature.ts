import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationAccountingFeatures } from '@/db/schema/schema';

// The underlying table (organization_accounting_features) is generic
// per-(org, feature_pack); the "accounting" in its name is historical.
// New non-accounting flags (e.g. 'recorder') live here too.
export type AccountingFeaturePack =
  | 'beneficial_trust'
  | 'business_trust'
  | 'nonprofit'
  | 'recorder';

/**
 * Whether the given org has the given accounting feature pack enabled.
 * Returns false if no row exists or `enabled=false`. Cheap single-row read;
 * caller may cache per-request if invoking repeatedly in a tight loop.
 */
export async function getOrgFeature(
	organizationId: string,
	featurePack: AccountingFeaturePack,
): Promise<boolean> {
	const features = await getOrgFeatures(organizationId, [featurePack]);
	return features[featurePack] ?? false;
}

export async function getOrgFeatures(
	organizationId: string,
	featurePacks: readonly AccountingFeaturePack[],
): Promise<Record<AccountingFeaturePack, boolean>> {
	if (featurePacks.length === 0) return {} as Record<AccountingFeaturePack, boolean>;
	const rows = await db
		.select({ featurePack: organizationAccountingFeatures.featurePack, enabled: organizationAccountingFeatures.enabled })
		.from(organizationAccountingFeatures)
		.where(
			and(
				eq(organizationAccountingFeatures.organizationId, organizationId),
				inArray(organizationAccountingFeatures.featurePack, featurePacks),
			),
		);
	const result = Object.fromEntries(featurePacks.map((pack) => [pack, false])) as Record<AccountingFeaturePack, boolean>;
	for (const row of rows) {
		result[row.featurePack as AccountingFeaturePack] = row.enabled ?? false;
	}
	return result;
}
