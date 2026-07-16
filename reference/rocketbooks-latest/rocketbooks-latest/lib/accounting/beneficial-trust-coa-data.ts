import { validateCoaTriple } from './coa-taxonomy';
import type { SeedAccount } from './default-coa-data';

/**
 * Chart of accounts seeded into a newly-onboarded beneficial-trust org.
 *
 * Sourced from the customer's "Chart of Accounts for Beneficial Trust"
 * spec (see [[reference-beneficial-trust-spec]]). Mostly mirrors the
 * spec's numbering. Account 001 (internal-transfers clearing account) is
 * intentionally omitted from v1 — the user can add it manually if they
 * use that pattern.
 *
 * Per-beneficiary demand-note sub-accounts (266, 267, …) are NOT in this
 * array — they're auto-seeded at runtime by seedBeneficialTrustCoa from
 * the trust_beneficiaries rows.
 *
 * No 'server-only' here so CLI scripts and the seeder can both import.
 */
export const BENEFICIAL_TRUST_COA: SeedAccount[] = [
  // ─── Assets (00x-1xx) ──────────────────────────────────────────────
  // 001 is a clearing account for internal bank-to-bank transfers — both
  // sides of an internal transfer hit this account, netting to zero. Used
  // by the PFC override for TRANSFER_IN/OUT_ACCOUNT_TRANSFER so transfers
  // don't get miscategorized as income/expense.
  { accountNumber: '001', accountName: 'Transfer Funds Between Bank Accounts', gaapType: 'asset', accountType: 'other_current_assets', detailType: 'trust_transfer_clearing', normalBalance: 'debit' },
  { accountNumber: '110', accountName: 'Accounts Receivable',           gaapType: 'asset', accountType: 'accounts_receivable',  detailType: 'accounts_receivable', normalBalance: 'debit' },
  { accountNumber: '120', accountName: 'Savings Account',               gaapType: 'asset', accountType: 'bank',                 detailType: 'savings',             normalBalance: 'debit' },
  { accountNumber: '125', accountName: 'Land',                          gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'land',                normalBalance: 'debit' },
  { accountNumber: '126', accountName: 'Buildings',                     gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'buildings',           normalBalance: 'debit' },
  { accountNumber: '130', accountName: 'Furniture & Fixtures',          gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'furniture_fixtures',  normalBalance: 'debit' },
  { accountNumber: '135', accountName: 'Equipment',                     gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'machinery_equipment', normalBalance: 'debit' },
  { accountNumber: '140', accountName: 'Vehicles',                      gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'vehicles',            normalBalance: 'debit' },
  { accountNumber: '145', accountName: 'Accumulated Depreciation',      gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'accumulated_depreciation', normalBalance: 'debit' },
  { accountNumber: '146', accountName: 'Accumulated Amortization',      gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'accumulated_amortization', normalBalance: 'debit' },
  { accountNumber: '150', accountName: 'Intangibles & IP',              gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'intangible_assets',   normalBalance: 'debit' },
  { accountNumber: '160', accountName: 'Investments',                   gaapType: 'asset', accountType: 'other_current_assets', detailType: 'investments_other',   normalBalance: 'debit' },

  // ─── Liabilities (2xx) ─────────────────────────────────────────────
  { accountNumber: '200', accountName: 'Accounts Payable',              gaapType: 'liability', accountType: 'accounts_payable',          detailType: 'accounts_payable',          normalBalance: 'credit' },
  { accountNumber: '220', accountName: 'Interest Payable',              gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'trust_interest_payable',    normalBalance: 'credit' },
  { accountNumber: '225', accountName: 'Taxes Payable',                 gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'trust_taxes_payable',       normalBalance: 'credit' },
  { accountNumber: '230', accountName: '1099 Wages Payable',            gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'trust_1099_wages_payable',  normalBalance: 'credit' },
  { accountNumber: '250', accountName: 'Notes Payable',                 gaapType: 'liability', accountType: 'long_term_liabilities',     detailType: 'notes_payable',             normalBalance: 'credit' },
  { accountNumber: '260', accountName: 'Trustee Demand Note',           gaapType: 'liability', accountType: 'long_term_liabilities',     detailType: 'trust_trustee_demand_note', normalBalance: 'credit' },
  { accountNumber: '265', accountName: "Beneficiaries' Demand Notes",   gaapType: 'liability', accountType: 'long_term_liabilities',     detailType: 'trust_beneficiary_demand_note', normalBalance: 'credit' },

  // ─── Equity (3xx) ──────────────────────────────────────────────────
  // 300 is the offset account for opening balances brought into the
  // trust (manually-entered fixed assets, migrated balances from a
  // prior bookkeeping system, etc.). Treated as the trust's principal
  // contribution — credit-normal, never directly transacted against.
  { accountNumber: '300', accountName: 'Trust Corpus',                   gaapType: 'equity', accountType: 'equity', detailType: 'opening_balance_equity',           normalBalance: 'credit' },
  // 310 is a contra-equity / draw account — taxable K-1 distributions
  // accumulate as debits, reducing the trust's equity. Posting triggers
  // K-1 issuance per the Phase 4 rules engine.
  { accountNumber: '310', accountName: 'Distributions to Beneficiaries', gaapType: 'equity', accountType: 'equity', detailType: 'trust_distributions_to_beneficiaries', normalBalance: 'debit' },

  // ─── Income (4xx) ──────────────────────────────────────────────────
  { accountNumber: '405', accountName: 'Interest Income',                gaapType: 'income', accountType: 'other_income', detailType: 'interest_earned',                   normalBalance: 'credit' },
  { accountNumber: '410', accountName: 'Dividend Income',                gaapType: 'income', accountType: 'other_income', detailType: 'dividend_income',                   normalBalance: 'credit' },
  { accountNumber: '420', accountName: 'Short-Term Capital Gains',       gaapType: 'income', accountType: 'other_income', detailType: 'trust_short_term_capital_gains',    normalBalance: 'credit' },
  { accountNumber: '425', accountName: 'Long-Term Capital Gains',        gaapType: 'income', accountType: 'other_income', detailType: 'trust_long_term_capital_gains',     normalBalance: 'credit' },
  { accountNumber: '430', accountName: 'Rental Income (Net)',            gaapType: 'income', accountType: 'other_income', detailType: 'trust_rental_income_net',           normalBalance: 'credit' },
  { accountNumber: '435', accountName: 'Equipment & IP Lease Income',    gaapType: 'income', accountType: 'other_income', detailType: 'trust_equipment_ip_lease_income',   normalBalance: 'credit' },
  // Asset disposal P&L. Used by the Assets module's disposeAsset action
  // — the gain side credits 460 when proceeds-fees exceed book value;
  // the loss side debits 660 when they don't. Standard trust accounting
  // puts both on the income statement to make Form 1041 line 4 (Capital
  // gain/loss) and line 7 (Ordinary income) reporting cleaner.
  { accountNumber: '460', accountName: 'Gain on Sale of Assets',         gaapType: 'income', accountType: 'other_income', detailType: 'other_miscellaneous_income',         normalBalance: 'credit' },
  { accountNumber: '440', accountName: 'Trustee Personal Use Lease',     gaapType: 'income', accountType: 'other_income', detailType: 'trust_personal_use_lease_income',   normalBalance: 'credit' },
  { accountNumber: '445', accountName: 'Royalty Income',                 gaapType: 'income', accountType: 'other_income', detailType: 'trust_royalty_income',              normalBalance: 'credit' },
  { accountNumber: '450', accountName: 'Business Income (K-1)',          gaapType: 'income', accountType: 'other_income', detailType: 'trust_business_income',             normalBalance: 'credit' },
  { accountNumber: '455', accountName: 'K-1 Income',                     gaapType: 'income', accountType: 'other_income', detailType: 'trust_k1_income',                   normalBalance: 'credit' },
  { accountNumber: '460', accountName: 'Other Income',                   gaapType: 'income', accountType: 'other_income', detailType: 'other_miscellaneous_income',        normalBalance: 'credit' },

  // ─── Expenses (5xx-8xx) ────────────────────────────────────────────
  { accountNumber: '500', accountName: 'Interest Expense',               gaapType: 'expense', accountType: 'expenses', detailType: 'interest_paid',                        normalBalance: 'debit' },
  { accountNumber: '505', accountName: 'Property Taxes',                 gaapType: 'expense', accountType: 'expenses', detailType: 'trust_property_taxes',                 normalBalance: 'debit' },
  { accountNumber: '510', accountName: 'Trustee Compensation (1099)',    gaapType: 'expense', accountType: 'expenses', detailType: 'trust_trustee_compensation',           normalBalance: 'debit' },
  { accountNumber: '515', accountName: 'Charitable Contributions',       gaapType: 'expense', accountType: 'expenses', detailType: 'charitable_contributions',             normalBalance: 'debit' },
  { accountNumber: '520', accountName: 'Accounting & Tax Prep',          gaapType: 'expense', accountType: 'expenses', detailType: 'trust_accounting_tax_prep',            normalBalance: 'debit' },
  { accountNumber: '530', accountName: 'Legal Services',                 gaapType: 'expense', accountType: 'expenses', detailType: 'trust_legal_services',                 normalBalance: 'debit' },
  { accountNumber: '600', accountName: 'Advertising',                    gaapType: 'expense', accountType: 'expenses', detailType: 'advertising_promotional',              normalBalance: 'debit' },
  { accountNumber: '605', accountName: 'Vehicle Expenses',               gaapType: 'expense', accountType: 'expenses', detailType: 'auto',                                 normalBalance: 'debit' },
  { accountNumber: '610', accountName: 'Bank & Credit Card Charges',     gaapType: 'expense', accountType: 'expenses', detailType: 'bank_charges',                         normalBalance: 'debit' },
  { accountNumber: '620', accountName: 'Professional Services',          gaapType: 'expense', accountType: 'expenses', detailType: 'trust_professional_services',          normalBalance: 'debit' },
  { accountNumber: '630', accountName: 'Consulting Fees',                gaapType: 'expense', accountType: 'expenses', detailType: 'trust_consulting_fees',                normalBalance: 'debit' },
  { accountNumber: '635', accountName: 'Medical & Wellness',             gaapType: 'expense', accountType: 'expenses', detailType: 'trust_medical_wellness',               normalBalance: 'debit' },
  { accountNumber: '640', accountName: 'Dues & Subscriptions',           gaapType: 'expense', accountType: 'expenses', detailType: 'dues_and_subscriptions',               normalBalance: 'debit' },
  { accountNumber: '645', accountName: 'Fees, Permits & Services',       gaapType: 'expense', accountType: 'expenses', detailType: 'trust_fees_permits_services',          normalBalance: 'debit' },
  { accountNumber: '650', accountName: 'Insurance - Property',           gaapType: 'expense', accountType: 'expenses', detailType: 'insurance',                            normalBalance: 'debit' },
  { accountNumber: '655', accountName: 'Insurance - Medical & Life',     gaapType: 'expense', accountType: 'expenses', detailType: 'trust_insurance_medical_life',         normalBalance: 'debit' },
  { accountNumber: '665', accountName: 'Supplies & Materials',           gaapType: 'expense', accountType: 'expenses', detailType: 'supplies_materials',                   normalBalance: 'debit' },
  { accountNumber: '670', accountName: 'Postage & Shipping',             gaapType: 'expense', accountType: 'expenses', detailType: 'shipping_freight_delivery',            normalBalance: 'debit' },
  { accountNumber: '680', accountName: 'Rents & Leases',                 gaapType: 'expense', accountType: 'expenses', detailType: 'rent_or_lease_buildings',              normalBalance: 'debit' },
  { accountNumber: '685', accountName: 'Repairs & Maintenance',          gaapType: 'expense', accountType: 'expenses', detailType: 'repair_maintenance',                   normalBalance: 'debit' },
  { accountNumber: '690', accountName: 'Office Expenses',                gaapType: 'expense', accountType: 'expenses', detailType: 'office_general_admin',                 normalBalance: 'debit' },
  { accountNumber: '695', accountName: 'Contract Labor',                 gaapType: 'expense', accountType: 'expenses', detailType: 'cost_of_labor',                        normalBalance: 'debit' },
  { accountNumber: '705', accountName: 'Non-Property Taxes',             gaapType: 'expense', accountType: 'expenses', detailType: 'trust_non_property_taxes',             normalBalance: 'debit' },
  { accountNumber: '710', accountName: 'Meals & Entertainment',          gaapType: 'expense', accountType: 'expenses', detailType: 'entertainment_meals',                  normalBalance: 'debit' },
  { accountNumber: '711', accountName: 'Meals for Service Workers',      gaapType: 'expense', accountType: 'expenses', detailType: 'trust_meals_for_workers',              normalBalance: 'debit' },
  { accountNumber: '715', accountName: 'Telephone',                      gaapType: 'expense', accountType: 'expenses', detailType: 'communication',                        normalBalance: 'debit' },
  { accountNumber: '720', accountName: 'Travel',                         gaapType: 'expense', accountType: 'expenses', detailType: 'travel',                               normalBalance: 'debit' },
  { accountNumber: '725', accountName: 'Utilities',                      gaapType: 'expense', accountType: 'expenses', detailType: 'utilities',                            normalBalance: 'debit' },
  { accountNumber: '730', accountName: 'Uniforms (Trust Logo)',          gaapType: 'expense', accountType: 'expenses', detailType: 'trust_uniforms',                       normalBalance: 'debit' },
  { accountNumber: '740', accountName: 'Education & Training',           gaapType: 'expense', accountType: 'expenses', detailType: 'trust_education_training',             normalBalance: 'debit' },
  { accountNumber: '745', accountName: 'Depreciation Expense',           gaapType: 'expense', accountType: 'other_expense', detailType: 'depreciation',                        normalBalance: 'debit' },
  { accountNumber: '660', accountName: 'Loss on Sale of Assets',         gaapType: 'expense', accountType: 'other_expense', detailType: 'other_miscellaneous_expense',         normalBalance: 'debit' },
  // 815/820 are gated by Phase 4 rules: only postable when recipient
  // beneficiary is under 21 OR incapacitated. The spec keeps these as
  // distinct accounts so a quick glance at the P&L shows minor-care vs.
  // adult-care spending.
  { accountNumber: '815', accountName: 'Food (Minors / Incapacitated)',     gaapType: 'expense', accountType: 'expenses', detailType: 'trust_food_minors_incapacitated',     normalBalance: 'debit' },
  { accountNumber: '820', accountName: 'Clothing (Minors / Incapacitated)', gaapType: 'expense', accountType: 'expenses', detailType: 'trust_clothing_minors_incapacitated', normalBalance: 'debit' },
];

// Module-load guard: every entry must reference canonical taxonomy values.
for (const a of BENEFICIAL_TRUST_COA) {
  const err = validateCoaTriple({ gaapType: a.gaapType, accountType: a.accountType, detailType: a.detailType });
  if (err) throw new Error(`BENEFICIAL_TRUST_COA invariant violated for ${a.accountNumber} ${a.accountName}: ${err}`);
}
