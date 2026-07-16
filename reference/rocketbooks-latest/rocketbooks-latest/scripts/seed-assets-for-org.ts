/**
 * One-shot: re-seed the beneficial-trust CoA for an org (idempotently
 * adds the new 145 / 146 / 745 depreciation accounts) and then seed the
 * default asset categories. Use for any trust org that existed before
 * the Fixed Assets phase 1 migration shipped.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/seed-assets-for-org.ts --org <uuid>
 */

import { seedBeneficialTrustCoa } from '@/lib/accounting/seed-beneficial-trust-coa';
import { seedDefaultAssetCategories } from '@/lib/accounting/seed-asset-categories';

async function main() {
	const orgIdIdx = process.argv.indexOf('--org');
	const orgId = orgIdIdx >= 0 ? process.argv[orgIdIdx + 1] : null;
	if (!orgId) {
		console.error('Usage: seed-assets-for-org.ts --org <uuid>');
		process.exit(2);
	}

	console.log(`Re-seeding trust CoA for org ${orgId} (adds 145/146/745 if missing)…`);
	const coa = await seedBeneficialTrustCoa({ organizationId: orgId });
	console.log(`  CoA: ${coa.inserted} inserted, ${coa.skipped} skipped (of ${coa.totalAccounts})`);

	console.log(`Seeding default asset categories…`);
	const n = await seedDefaultAssetCategories({ organizationId: orgId });
	console.log(`  Asset categories inserted: ${n}`);

	process.exit(0);
}

main().catch((err) => {
	console.error('SEED ERROR:', err);
	process.exit(1);
});
