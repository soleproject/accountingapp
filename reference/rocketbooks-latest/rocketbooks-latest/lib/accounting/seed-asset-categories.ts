import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { assetCategories, chartOfAccounts } from '@/db/schema/schema';

/**
 * Seed the default fixed-asset categories for a trust org once the
 * beneficial-trust CoA has been seeded (so the 1xx / 7xx accounts that
 * back each triple are guaranteed to exist).
 *
 * Each category maps to a triple of GL accounts:
 *   Asset account                — debit-normal, holds cost basis
 *   Accumulated Depreciation     — contra-asset, accumulates monthly dep
 *   Depreciation Expense         — P&L hit each period
 *
 * Buildings, F&F, Equipment, Vehicles share the single 145 Accum Dep
 * account (per QBO convention — per-asset detail lives in the register,
 * not in COA sub-accounts). Intangibles use 146 Accum Amortization. Land
 * doesn't get a category because it isn't depreciable.
 *
 * Idempotent: matches existing categories by (org, name) and skips them.
 * Returns the count of newly-inserted rows. Safe to re-run.
 */
export async function seedDefaultAssetCategories(args: {
	organizationId: string;
}): Promise<number> {
	const orgId = args.organizationId;

	// Resolve the trust CoA account ids we'll need by detail_type. If any
	// are missing (org wasn't seeded with the new accumulated-dep accounts
	// yet) we early-return — caller should run seedBeneficialTrustCoa first.
	const needed = new Set([
		'buildings',
		'furniture_fixtures',
		'machinery_equipment',
		'vehicles',
		'intangible_assets',
		'accumulated_depreciation',
		'accumulated_amortization',
		'depreciation',
	]);
	const rows = await db
		.select({
			id: chartOfAccounts.id,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.organizationId, orgId));
	const byDetail = new Map<string, string>();
	for (const r of rows) {
		if (r.detailType && needed.has(r.detailType)) {
			byDetail.set(r.detailType, r.id);
		}
	}

	const accumDep = byDetail.get('accumulated_depreciation');
	const accumAmort = byDetail.get('accumulated_amortization');
	const depExp = byDetail.get('depreciation');
	if (!accumDep || !accumAmort || !depExp) {
		// Trust CoA hasn't seeded the new depreciation accounts. Caller
		// should re-run seedBeneficialTrustCoa, which is idempotent and
		// will add 145/146/745. Return 0 so the asset-category seeding
		// doesn't half-fail.
		return 0;
	}

	type CategoryDef = {
		name: string;
		assetDetail: string;
		accumAccountId: string;
		expenseAccountId: string;
		defaultUsefulLifeMonths: number;
	};
	const defs: CategoryDef[] = [
		// Useful-life defaults track IRS Pub 946 Class Life Asset Depreciation
		// Range tables. Buildings use 39 yr non-residential SL by default
		// (residential 27.5 yr would be a per-asset override).
		{ name: 'Buildings', assetDetail: 'buildings', accumAccountId: accumDep, expenseAccountId: depExp, defaultUsefulLifeMonths: 39 * 12 },
		{ name: 'Furniture & Fixtures', assetDetail: 'furniture_fixtures', accumAccountId: accumDep, expenseAccountId: depExp, defaultUsefulLifeMonths: 7 * 12 },
		{ name: 'Equipment', assetDetail: 'machinery_equipment', accumAccountId: accumDep, expenseAccountId: depExp, defaultUsefulLifeMonths: 7 * 12 },
		{ name: 'Vehicles', assetDetail: 'vehicles', accumAccountId: accumDep, expenseAccountId: depExp, defaultUsefulLifeMonths: 5 * 12 },
		{ name: 'Intangibles & IP', assetDetail: 'intangible_assets', accumAccountId: accumAmort, expenseAccountId: depExp, defaultUsefulLifeMonths: 15 * 12 },
	];

	// Skip names that already exist for this org. The (org, name) unique
	// constraint would reject duplicates anyway, but checking first lets
	// us return an accurate count of net-new categories.
	const existing = await db
		.select({ name: assetCategories.name })
		.from(assetCategories)
		.where(eq(assetCategories.organizationId, orgId));
	const existingNames = new Set(existing.map((e) => e.name));

	let inserted = 0;
	for (const d of defs) {
		if (existingNames.has(d.name)) continue;
		const assetAccountId = byDetail.get(d.assetDetail);
		if (!assetAccountId) continue;
		try {
			await db.insert(assetCategories).values({
				id: randomUUID(),
				organizationId: orgId,
				name: d.name,
				assetAccountId,
				accumulatedDepAccountId: d.accumAccountId,
				depExpenseAccountId: d.expenseAccountId,
				defaultMethod: 'straight_line',
				defaultUsefulLifeMonths: d.defaultUsefulLifeMonths,
				defaultSalvagePct: '0',
				defaultAutoDepreciate: false,
			});
			inserted += 1;
		} catch {
			// Defensive — race against another seed call. Just continue.
		}
	}

	return inserted;
}
