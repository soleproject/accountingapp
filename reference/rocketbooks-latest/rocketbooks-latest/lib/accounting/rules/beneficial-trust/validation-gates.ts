import type { TrustLineContext, TrustJournalEntryContext } from './context';
import type { TrustFinding } from './types';

/**
 * Per-line validation gates. Fires once per non-trust-category-account
 * encountered in the JE. The main evaluator dedupes findings sharing the
 * same (code, accountNumber) so multi-line entries that all touch the
 * same off-template account only warn once.
 */
export function evaluateLineValidationGates(ctx: TrustLineContext): TrustFinding[] {
	const findings: TrustFinding[] = [];

	if (ctx.account.detailType && !isAcceptedTrustDetail(ctx.account.detailType)) {
		findings.push({
			code: 'TRUST_NON_TRUST_CATEGORY_USED',
			severity: 'warn',
			message: `Posted to "${ctx.account.accountName}" (${ctx.account.accountNumber}) — this account isn't part of the beneficial-trust chart of accounts. Re-categorize to a trust-specific account if one fits, or confirm this expense category is appropriate for a beneficial trust.`,
			metadata: {
				accountNumber: ctx.account.accountNumber,
				accountId: ctx.account.id,
				detailType: ctx.account.detailType,
			},
		});
	}

	return findings;
}

/**
 * JE-level validation gates. Fires once per JE, not per line. Currently
 * just the no-receipt-withdrawal gate — only fires for transaction-sourced
 * JEs where the inferred type is 'withdrawal' AND no receipt is attached.
 *
 * QBO-sourced and receipt-match-sourced JEs don't fire this gate (the
 * "receipt" concept either doesn't apply or the receipt is the source).
 */
export function evaluateJournalEntryValidationGates(
	ctx: TrustJournalEntryContext,
): TrustFinding[] {
	const findings: TrustFinding[] = [];

	if (
		ctx.sourceType === 'transaction' &&
		ctx.type === 'withdrawal' &&
		!ctx.hasReceipt
	) {
		findings.push({
			code: 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION',
			severity: 'warn',
			message: `Withdrawal posted without an attached receipt. If this is not a vendor expense backed by documentation, it may need to be reclassified as a taxable distribution (account 310).`,
		});
	}

	return findings;
}

function isAcceptedTrustDetail(detailType: string): boolean {
	if (TRUST_ACCEPTED_DETAIL_TYPES.has(detailType)) return true;
	return DYNAMIC_TRUST_PREFIXES.some((p) => detailType.startsWith(p));
}

/**
 * Detail-type slugs that BENEFICIAL_TRUST_COA seeds (either trust-specific
 * `trust_*` slugs or canonical slugs the trust COA explicitly reuses). Any
 * other slug under a trust org's COA is either (a) a leftover from the
 * pre-wipe default COA or (b) an auto-created bank/credit-card account.
 * The validation gate flags it for human review.
 *
 * Keep in sync with `lib/accounting/beneficial-trust-coa-data.ts`.
 */
const TRUST_ACCEPTED_DETAIL_TYPES = new Set<string>([
	// Assets
	'trust_transfer_clearing',
	'accounts_receivable',
	'savings',
	'land',
	'buildings',
	'furniture_fixtures',
	'machinery_equipment',
	'vehicles',
	'intangible_assets',
	'investments_other',
	// Bank-side slugs auto-created by autoCreateBankCoa — not in the trust
	// template but legitimate for trust orgs that connect Plaid.
	'checking',
	'cash_on_hand',
	'money_market',
	'trust_account',
	'rents_held_in_trust',
	'credit_card',
	// Liabilities
	'accounts_payable',
	'trust_interest_payable',
	'trust_taxes_payable',
	'trust_1099_wages_payable',
	'notes_payable',
	'trust_trustee_demand_note',
	'trust_beneficiary_demand_note',
	// Equity
	'trust_distributions_to_beneficiaries',
	// Income
	'interest_earned',
	'dividend_income',
	'trust_short_term_capital_gains',
	'trust_long_term_capital_gains',
	'trust_rental_income_net',
	'trust_equipment_ip_lease_income',
	'trust_personal_use_lease_income',
	'trust_royalty_income',
	'trust_business_income',
	'trust_k1_income',
	'other_miscellaneous_income',
	// Expenses
	'interest_paid',
	'trust_property_taxes',
	'trust_trustee_compensation',
	'charitable_contributions',
	'trust_accounting_tax_prep',
	'trust_legal_services',
	'advertising_promotional',
	'auto',
	'bank_charges',
	'trust_professional_services',
	'trust_consulting_fees',
	'trust_medical_wellness',
	'dues_and_subscriptions',
	'trust_fees_permits_services',
	'insurance',
	'trust_insurance_medical_life',
	'supplies_materials',
	'shipping_freight_delivery',
	'rent_or_lease_buildings',
	'repair_maintenance',
	'office_general_admin',
	'cost_of_labor',
	'trust_non_property_taxes',
	'entertainment_meals',
	'trust_meals_for_workers',
	'communication',
	'travel',
	'utilities',
	'trust_uniforms',
	'trust_education_training',
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
]);

// Dynamic slugs that aren't in the set above but are legitimate for a
// trust org. isAcceptedTrustDetail() allows them via prefix match.
const DYNAMIC_TRUST_PREFIXES = [
	// Per-beneficiary demand-note sub-accounts (`trust_beneficiary_demand_note__<short-uuid>`).
	'trust_beneficiary_demand_note__',
	// auto-create-bank-coa.ts builds bank detail slugs as `{base}_{last4}`
	// (e.g. `checking_6084`) so two checking accounts in the same org don't
	// collide on UNIQUE(org, gaap_type, detail_type). Without these prefixes
	// every Plaid bank line would falsely flag as TRUST_NON_TRUST_CATEGORY_USED.
	'checking_',
	'savings_',
	'money_market_',
	'cd_',
	'credit_card_',
];
