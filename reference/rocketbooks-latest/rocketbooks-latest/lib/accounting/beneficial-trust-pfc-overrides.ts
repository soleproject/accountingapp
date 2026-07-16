import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, pfcOrgOverrides } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

/**
 * Per-org PFC → CoA overrides applied automatically to every beneficial-
 * trust org at onboarding. Without these, the generic pfc-coa-mapping
 * resolves Plaid PFCs to canonical slugs (personal_expense, checking,
 * credit_card, uncategorized_expense, …) that don't exist in
 * BENEFICIAL_TRUST_COA — so the resolver falls through to null and the
 * transaction stays uncategorized.
 *
 * Convention: catalog entries reference the trust account by its
 * NUMBER (e.g. '605', '265', '001') rather than detail-type slug. The
 * seeder looks up the corresponding chart_of_accounts.id at runtime and
 * inserts a pfc_org_overrides row. If an account number isn't found in
 * the org's CoA (e.g. the user removed it), that override is skipped
 * with a warning — non-fatal.
 *
 * Prohibited personal categories (groceries, clothing, video games, vet
 * bills, etc.) route to **265** (parent Beneficiaries' Demand Notes).
 * Per the spec, when the trust pays for personal stuff that's a draw
 * against the beneficiary's demand note. The categorizer can't know
 * WHICH beneficiary, so it lands on the parent — the Trust Review queue
 * flags it and the user re-routes to a specific 26x sub-account at
 * review time.
 *
 * Internal bank-to-bank transfers route to **001** (Transfer Clearing).
 * Both sides of the transfer hit 001 so it nets to zero on the balance
 * sheet — the audit trail lives in the transaction list, not the GL.
 */

export interface TrustPfcOverride {
	pfcDetailed: string;
	/** Trust account number from BENEFICIAL_TRUST_COA (e.g. '605', '265'). */
	accountNumber: string;
	note?: string;
}

export const TRUST_PFC_OVERRIDES: readonly TrustPfcOverride[] = [
	// ─── INCOME ─────────────────────────────────────────────────────────
	{ pfcDetailed: 'INCOME_CHILD_SUPPORT',           accountNumber: '265', note: 'Beneficiary personal income deposited — credits their demand note.' },
	{ pfcDetailed: 'INCOME_CONTRACTOR',              accountNumber: '460', note: 'Direct business income is prohibited for trust — flag for K-1 routing.' },
	{ pfcDetailed: 'INCOME_DIVIDENDS',               accountNumber: '410' },
	{ pfcDetailed: 'INCOME_GIG_ECONOMY',             accountNumber: '460', note: 'Direct business income is prohibited — flag.' },
	{ pfcDetailed: 'INCOME_LONG_TERM_DISABILITY',    accountNumber: '265', note: 'Beneficiary personal income — credits their demand note.' },
	{ pfcDetailed: 'INCOME_MILITARY',                accountNumber: '265' },
	{ pfcDetailed: 'INCOME_RENTAL',                  accountNumber: '430', note: 'Routes to net rental — gross/expense split is deferred.' },
	{ pfcDetailed: 'INCOME_RETIREMENT_PENSION',      accountNumber: '265' },
	{ pfcDetailed: 'INCOME_SALARY',                  accountNumber: '265' },
	{ pfcDetailed: 'INCOME_TAX_REFUND',              accountNumber: '460' },
	{ pfcDetailed: 'INCOME_UNEMPLOYMENT',            accountNumber: '265' },
	{ pfcDetailed: 'INCOME_OTHER',                   accountNumber: '460' },

	// ─── LOAN_DISBURSEMENTS (trust borrows) ─────────────────────────────
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_AUTO',                  accountNumber: '250' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_CASH_ADVANCES',         accountNumber: '250' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_EWA',                   accountNumber: '250' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_MORTGAGE',              accountNumber: '250' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_PERSONAL',              accountNumber: '250' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_STUDENT',               accountNumber: '265', note: 'Personal student loan — routes to beneficiary demand note.' },
	{ pfcDetailed: 'LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT',    accountNumber: '250' },

	// ─── LOAN_PAYMENTS (paying down debt) ───────────────────────────────
	{ pfcDetailed: 'LOAN_PAYMENTS_BNPL',                  accountNumber: '250' },
	{ pfcDetailed: 'LOAN_PAYMENTS_CAR_PAYMENT',           accountNumber: '250', note: 'Principal/interest split deferred — flagged at posting.' },
	{ pfcDetailed: 'LOAN_PAYMENTS_CASH_ADVANCES',         accountNumber: '250' },
	{ pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',   accountNumber: '250', note: 'Trust COA has no credit-card type — routes to Notes Payable.' },
	{ pfcDetailed: 'LOAN_PAYMENTS_EWA',                   accountNumber: '250' },
	{ pfcDetailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',      accountNumber: '250' },
	{ pfcDetailed: 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', accountNumber: '265' },
	{ pfcDetailed: 'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',  accountNumber: '265' },
	{ pfcDetailed: 'LOAN_PAYMENTS_OTHER_PAYMENT',         accountNumber: '250' },

	// ─── TRANSFER_IN ────────────────────────────────────────────────────
	{ pfcDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',                accountNumber: '001', note: 'Internal bank-to-bank → clearing account (nets to zero).' },
	{ pfcDetailed: 'TRANSFER_IN_DEPOSIT',                         accountNumber: '460', note: 'Unknown deposit — flag for review (K-1 vs interest vs other).' },
	{ pfcDetailed: 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS', accountNumber: '160' },
	{ pfcDetailed: 'TRANSFER_IN_SAVINGS',                         accountNumber: '120' },
	{ pfcDetailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS',           accountNumber: '460', note: 'Venmo/Zelle/Cashapp inbound — flag for K-1 vs personal review.' },
	{ pfcDetailed: 'TRANSFER_IN_WIRE',                            accountNumber: '460', note: 'Wire inbound — flag for K-1 vs distribution review.' },
	{ pfcDetailed: 'TRANSFER_IN_OTHER_TRANSFER_IN',               accountNumber: '460' },

	// ─── TRANSFER_OUT ───────────────────────────────────────────────────
	{ pfcDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',                accountNumber: '001' },
	{ pfcDetailed: 'TRANSFER_OUT_CRYPTO',                          accountNumber: '265' },
	{ pfcDetailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS', accountNumber: '160' },
	{ pfcDetailed: 'TRANSFER_OUT_SAVINGS',                         accountNumber: '120' },
	{ pfcDetailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS',          accountNumber: '265' },
	{ pfcDetailed: 'TRANSFER_OUT_WIRE',                            accountNumber: '265' },
	{ pfcDetailed: 'TRANSFER_OUT_WITHDRAWAL',                      accountNumber: '260', note: 'Cash withdrawals typically trustee draws.' },
	{ pfcDetailed: 'TRANSFER_OUT_OTHER_TRANSFER_OUT',              accountNumber: '265' },

	// ─── ENTERTAINMENT (mostly prohibited for trust) ────────────────────
	{ pfcDetailed: 'ENTERTAINMENT_CASINOS_AND_GAMBLING',                         accountNumber: '265' },
	// MUSIC_AND_AUDIO + TV_AND_MOVIES default to dues_and_subscriptions (640) — trust HAS this slug, no override.
	{ pfcDetailed: 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS', accountNumber: '265' },
	{ pfcDetailed: 'ENTERTAINMENT_VIDEO_GAMES',                                  accountNumber: '265' },
	{ pfcDetailed: 'ENTERTAINMENT_OTHER_ENTERTAINMENT',                          accountNumber: '265' },

	// ─── FOOD_AND_DRINK ─────────────────────────────────────────────────
	// RESTAURANT/FAST_FOOD/COFFEE/BEER_WINE default to entertainment_meals (710) — trust HAS, no override.
	// VENDING_MACHINES defaults to travel_meals — trust doesn't have, route to 710.
	// OTHER_FOOD_AND_DRINK → 710 default works.
	{ pfcDetailed: 'FOOD_AND_DRINK_GROCERIES',         accountNumber: '265', note: 'Groceries on a trust account are personal — beneficiary demand note.' },
	{ pfcDetailed: 'FOOD_AND_DRINK_VENDING_MACHINES',  accountNumber: '710' },

	// ─── GENERAL_MERCHANDISE (default → supplies_materials 665) ─────────
	// Most default to supplies_materials (665) or office_general_admin (690) which trust has — no overrides needed.
	{ pfcDetailed: 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', accountNumber: '265' },
	{ pfcDetailed: 'GENERAL_MERCHANDISE_PET_SUPPLIES',             accountNumber: '265' },
	{ pfcDetailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS',           accountNumber: '265' },
	{ pfcDetailed: 'GENERAL_MERCHANDISE_TOBACCO_AND_VAPE',         accountNumber: '265' },

	// ─── HOME_IMPROVEMENT (default → personal_expense which trust doesn't have) ──
	{ pfcDetailed: 'HOME_IMPROVEMENT_FURNITURE',              accountNumber: '130', note: 'Furniture for trust-owned property — re-route to 265 if personal.' },
	{ pfcDetailed: 'HOME_IMPROVEMENT_HARDWARE',               accountNumber: '685' },
	{ pfcDetailed: 'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE', accountNumber: '685' },
	{ pfcDetailed: 'HOME_IMPROVEMENT_SECURITY',               accountNumber: '685' },
	{ pfcDetailed: 'HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT', accountNumber: '685' },

	// ─── MEDICAL (default → personal_expense) ───────────────────────────
	{ pfcDetailed: 'MEDICAL_DENTAL_CARE',                accountNumber: '635' },
	{ pfcDetailed: 'MEDICAL_EYE_CARE',                   accountNumber: '635' },
	{ pfcDetailed: 'MEDICAL_NURSING_CARE',               accountNumber: '635' },
	{ pfcDetailed: 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', accountNumber: '635' },
	{ pfcDetailed: 'MEDICAL_PRIMARY_CARE',               accountNumber: '635' },
	{ pfcDetailed: 'MEDICAL_VETERINARY_SERVICES',        accountNumber: '265', note: 'Vet bills are personal per spec.' },
	{ pfcDetailed: 'MEDICAL_OTHER_MEDICAL',              accountNumber: '635' },

	// ─── PERSONAL_CARE (all prohibited per spec) ───────────────────────
	{ pfcDetailed: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', accountNumber: '265' },
	{ pfcDetailed: 'PERSONAL_CARE_HAIR_AND_BEAUTY',          accountNumber: '265' },
	{ pfcDetailed: 'PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING', accountNumber: '265' },
	{ pfcDetailed: 'PERSONAL_CARE_OTHER_PERSONAL_CARE',      accountNumber: '265' },

	// ─── GENERAL_SERVICES ──────────────────────────────────────────────
	{ pfcDetailed: 'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING', accountNumber: '520' },
	{ pfcDetailed: 'GENERAL_SERVICES_AUTOMOTIVE',                        accountNumber: '605', note: 'Vehicle service — routes to Vehicle Expenses.' },
	{ pfcDetailed: 'GENERAL_SERVICES_CHILDCARE',                         accountNumber: '265' },
	{ pfcDetailed: 'GENERAL_SERVICES_CONSULTING_AND_LEGAL',              accountNumber: '530' },
	{ pfcDetailed: 'GENERAL_SERVICES_EDUCATION',                         accountNumber: '740', note: 'Education for trust purpose — re-route to 265 if personal.' },
	// INSURANCE default → 650 (insurance) which trust has — no override.
	{ pfcDetailed: 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',              accountNumber: '670' },
	// STORAGE default → 680 (rent_or_lease_buildings) which trust has — no override.
	{ pfcDetailed: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES',            accountNumber: '620' },

	// ─── GOVERNMENT_AND_NON_PROFIT ─────────────────────────────────────
	{ pfcDetailed: 'GOVERNMENT_AND_NON_PROFIT_DONATIONS',                          accountNumber: '515' },
	{ pfcDetailed: 'GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES', accountNumber: '645' },
	{ pfcDetailed: 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT',                        accountNumber: '705' },
	{ pfcDetailed: 'GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT',    accountNumber: '645' },

	// ─── TRANSPORTATION (default → travel_transportation, not in trust) ────
	{ pfcDetailed: 'TRANSPORTATION_BIKES_AND_SCOOTERS',    accountNumber: '720' },
	{ pfcDetailed: 'TRANSPORTATION_GAS',                   accountNumber: '605' },
	{ pfcDetailed: 'TRANSPORTATION_PARKING',               accountNumber: '605' },
	{ pfcDetailed: 'TRANSPORTATION_PUBLIC_TRANSIT',        accountNumber: '720' },
	{ pfcDetailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES', accountNumber: '720' },
	{ pfcDetailed: 'TRANSPORTATION_TOLLS',                 accountNumber: '605' },
	{ pfcDetailed: 'TRANSPORTATION_OTHER_TRANSPORTATION',  accountNumber: '605' },

	// ─── TRAVEL (default → travel/travel_lodging/travel_transportation) ────
	// FLIGHTS default → travel (720) — trust has, no override.
	{ pfcDetailed: 'TRAVEL_LODGING',     accountNumber: '720', note: 'Trust has no lodging sub-slot — routes to general Travel.' },
	{ pfcDetailed: 'TRAVEL_RENTAL_CARS', accountNumber: '605' },
	// OTHER_TRAVEL default → 720, no override.

	// ─── RENT_AND_UTILITIES ────────────────────────────────────────────
	// Most → utilities (725) — trust has, no override.
	{ pfcDetailed: 'RENT_AND_UTILITIES_TELEPHONE', accountNumber: '715' },
	// RENT default → 680 (rent_or_lease_buildings) — trust has, no override.

	// ─── OTHER ────────────────────────────────────────────────────────
	{ pfcDetailed: 'OTHER_OTHER', accountNumber: '460' },
];

/**
 * Seed pfc_org_overrides rows for a beneficial-trust org. Idempotent:
 * upserts by (org, pfc) so re-runs don't duplicate. Skips any override
 * whose target account number isn't found in the org's CoA (logs a
 * warning — non-fatal).
 *
 * Returns counts of {inserted, updated, skipped} for reporting.
 */
export async function seedTrustPfcOverrides(args: {
	organizationId: string;
}): Promise<{ inserted: number; updated: number; skipped: number }> {
	// Load every account number → id mapping for this org once.
	const accounts = await db
		.select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber })
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.organizationId, args.organizationId));
	const idByNumber = new Map(accounts.map((a) => [a.accountNumber, a.id]));

	let inserted = 0;
	let updated = 0;
	let skipped = 0;

	for (const override of TRUST_PFC_OVERRIDES) {
		const accountId = idByNumber.get(override.accountNumber);
		if (!accountId) {
			logger.warn(
				{ orgId: args.organizationId, pfc: override.pfcDetailed, accountNumber: override.accountNumber },
				'seedTrustPfcOverrides: account number not found in CoA, skipping',
			);
			skipped++;
			continue;
		}

		const existing = await db
			.select({ id: pfcOrgOverrides.id, categoryAccountId: pfcOrgOverrides.categoryAccountId })
			.from(pfcOrgOverrides)
			.where(
				and(
					eq(pfcOrgOverrides.organizationId, args.organizationId),
					eq(pfcOrgOverrides.pfcDetailed, override.pfcDetailed),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			await db.insert(pfcOrgOverrides).values({
				id: randomUUID(),
				organizationId: args.organizationId,
				pfcDetailed: override.pfcDetailed,
				categoryAccountId: accountId,
				source: 'beneficial_trust_seed',
				reasoning: override.note ?? null,
			});
			inserted++;
		} else if (existing[0].categoryAccountId !== accountId) {
			// Existing row points at a different account — refresh it. This
			// handles cases where the trust account ids changed (e.g. after a
			// re-seed that wiped + recreated the CoA).
			await db
				.update(pfcOrgOverrides)
				.set({
					categoryAccountId: accountId,
					source: 'beneficial_trust_seed',
					reasoning: override.note ?? null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(pfcOrgOverrides.id, existing[0].id));
			updated++;
		}
		// existing override already points at the right account → no-op
	}

	return { inserted, updated, skipped };
}
