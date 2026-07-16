/**
 * Canonical chart-of-accounts taxonomy.
 *
 * Source of truth for what (gaap_type, account_type, detail_type) values are
 * valid in chart_of_accounts. Mirrors the QuickBooks-style classification
 * used across the product (per "RocketBooks - Chart of Account Type & Detail").
 *
 *   GAAP type → 5 broad classes used by reports (balance sheet, P&L, etc.)
 *   Account type → 15 user-facing classes shown in pickers
 *   Detail type → fine-grained slug stored on each row
 *
 * The chart_of_accounts table has UNIQUE (organization_id, gaap_type,
 * detail_type), so detail slugs must be distinct within each gaap_type. All
 * slugs below have been audited for that (see test in seed-default-coa.ts
 * usage + balance_sheet/income_statement isType() comparisons).
 *
 * No 'server-only' here — this is pure data, safely imported by client
 * components for picker UIs.
 */

export const GAAP_TYPES = ['asset', 'liability', 'income', 'expense', 'equity'] as const;
export type GaapType = (typeof GAAP_TYPES)[number];

export interface CanonicalDetail {
  /** Stable slug stored in chart_of_accounts.detail_type. */
  slug: string;
  /** Display label shown in pickers and reports. */
  label: string;
}

export interface AccountTypeDef {
  /** Stable slug stored in chart_of_accounts.account_type. */
  slug: string;
  /** Display label shown in pickers and reports. */
  label: string;
  gaapType: GaapType;
  normalBalance: 'debit' | 'credit';
  details: readonly CanonicalDetail[];
}

const detail = (slug: string, label: string): CanonicalDetail => ({ slug, label });

export const ACCOUNT_TYPES: readonly AccountTypeDef[] = [
  // ─── Assets ────────────────────────────────────────────────────────
  {
    slug: 'accounts_receivable',
    label: 'Accounts Receivable (A/R)',
    gaapType: 'asset',
    normalBalance: 'debit',
    details: [detail('accounts_receivable', 'Accounts Receivable (A/R)')],
  },
  {
    slug: 'other_current_assets',
    label: 'Other Current Assets',
    gaapType: 'asset',
    normalBalance: 'debit',
    details: [
      detail('allowance_for_bad_debts', 'Allowance for Bad Debts'),
      detail('development_costs', 'Development Costs'),
      detail('employee_cash_advances', 'Employee Cash Advances'),
      detail('inventory', 'Inventory'),
      detail('investment_mortgage_real_estate_loans', 'Investment - Mortgage/Real Estate Loans'),
      detail('investment_tax_exempt_securities', 'Investment - Tax-Exempt Securities'),
      detail('investment_us_government_obligations', 'Investment - U.S. Government Obligations'),
      detail('investments_other', 'Investments - Other'),
      detail('loans_to_officers', 'Loans To Officers'),
      detail('loans_to_others', 'Loans to Others'),
      detail('loans_to_stockholders', 'Loans to Stockholders'),
      detail('other_current_assets', 'Other Current Assets'),
      detail('prepaid_expenses', 'Prepaid Expenses'),
      detail('retainage', 'Retainage'),
      detail('undeposited_funds', 'Undeposited Funds'),
      // Beneficial-trust accounting — clearing account for internal
      // bank-to-bank transfers (account 001). Debits + credits net to zero.
      detail('trust_transfer_clearing', 'Trust Transfer Clearing'),
    ],
  },
  {
    slug: 'bank',
    label: 'Bank',
    gaapType: 'asset',
    normalBalance: 'debit',
    details: [
      detail('cash_on_hand', 'Cash on Hand'),
      detail('checking', 'Checking'),
      detail('money_market', 'Money Market'),
      detail('rents_held_in_trust', 'Rents Held in Trust'),
      detail('savings', 'Savings'),
      detail('trust_account', 'Trust Account'),
    ],
  },
  {
    slug: 'fixed_assets',
    label: 'Fixed Assets',
    gaapType: 'asset',
    normalBalance: 'debit',
    details: [
      detail('accumulated_amortization', 'Accumulated Amortization'),
      detail('accumulated_depletion', 'Accumulated Depletion'),
      detail('accumulated_depreciation', 'Accumulated Depreciation'),
      detail('buildings', 'Buildings'),
      detail('depletable_assets', 'Depletable Assets'),
      detail('fixed_asset_computers', 'Fixed Asset Computers'),
      detail('fixed_asset_copiers', 'Fixed Asset Copiers'),
      detail('fixed_asset_furniture', 'Fixed Asset Furniture'),
      detail('fixed_asset_other_tools_equipment', 'Fixed Asset Other Tools Equipment'),
      detail('fixed_asset_phone', 'Fixed Asset Phone'),
      detail('fixed_asset_photo_video', 'Fixed Asset Photo Video'),
      detail('fixed_asset_software', 'Fixed Asset Software'),
      detail('furniture_fixtures', 'Furniture & Fixtures'),
      detail('intangible_assets', 'Intangible Assets'),
      detail('land', 'Land'),
      detail('leasehold_improvements', 'Leasehold Improvements'),
      detail('machinery_equipment', 'Machinery & Equipment'),
      detail('other_fixed_assets', 'Other Fixed Assets'),
      detail('vehicles', 'Vehicles'),
    ],
  },
  {
    slug: 'other_assets',
    label: 'Other Assets',
    gaapType: 'asset',
    normalBalance: 'debit',
    details: [
      detail('accumulated_amortization_other_assets', 'Accumulated Amortization of Other Assets'),
      detail('goodwill', 'Goodwill'),
      detail('lease_buyout', 'Lease Buyout'),
      detail('licenses', 'Licenses'),
      detail('organizational_costs', 'Organizational Costs'),
      detail('other_long_term_assets', 'Other Long-term Assets'),
      detail('security_deposits', 'Security Deposits'),
    ],
  },

  // ─── Liabilities ───────────────────────────────────────────────────
  {
    slug: 'accounts_payable',
    label: 'Accounts Payable (A/P)',
    gaapType: 'liability',
    normalBalance: 'credit',
    details: [detail('accounts_payable', 'Accounts Payable (A/P)')],
  },
  {
    slug: 'credit_card',
    label: 'Credit Card',
    gaapType: 'liability',
    normalBalance: 'credit',
    details: [detail('credit_card', 'Credit Card')],
  },
  {
    slug: 'other_current_liabilities',
    label: 'Other Current Liabilities',
    gaapType: 'liability',
    normalBalance: 'credit',
    details: [
      detail('deferred_revenue', 'Deferred Revenue'),
      detail('federal_income_tax_payable', 'Federal Income Tax Payable'),
      detail('insurance_payable', 'Insurance Payable'),
      detail('line_of_credit', 'Line of Credit'),
      detail('loan_payable', 'Loan Payable'),
      detail('other_current_liabilities', 'Other Current Liabilities'),
      detail('payroll_clearing', 'Payroll Clearing'),
      detail('payroll_tax_payable', 'Payroll Tax Payable'),
      detail('prepaid_expenses_payable', 'Prepaid Expenses Payable'),
      detail('rents_in_trust_liability', 'Rents in Trust - Liability'),
      detail('sales_tax_payable', 'Sales Tax Payable'),
      detail('state_local_income_tax_payable', 'State/Local Income Tax Payable'),
      detail('trust_accounts_liabilities', 'Trust Accounts - Liabilities'),
      detail('undistributed_tips', 'Undistributed Tips'),
      // Beneficial-trust accounting (see lib/accounting/beneficial-trust-coa-data.ts).
      detail('trust_interest_payable', 'Trust Interest Payable'),
      detail('trust_taxes_payable', 'Trust Taxes Payable'),
      detail('trust_1099_wages_payable', 'Trust 1099 Wages Payable'),
    ],
  },
  {
    slug: 'long_term_liabilities',
    label: 'Long Term Liabilities',
    gaapType: 'liability',
    normalBalance: 'credit',
    details: [
      detail('notes_payable', 'Notes Payable'),
      detail('other_long_term_liabilities', 'Other Long Term Liabilities'),
      detail('shareholder_notes_payable', 'Shareholder Notes Payable'),
      // Beneficial-trust accounting. Per-beneficiary children of the
      // `trust_beneficiary_demand_note` parent use dynamic detail slugs
      // (`trust_beneficiary_demand_note__<short-uuid>`) that intentionally
      // bypass canonical validation; see seed-beneficial-trust-coa.ts.
      detail('trust_trustee_demand_note', 'Trustee Demand Note'),
      detail('trust_beneficiary_demand_note', "Beneficiaries' Demand Notes"),
    ],
  },

  // ─── Equity ────────────────────────────────────────────────────────
  {
    slug: 'equity',
    label: 'Equity',
    gaapType: 'equity',
    normalBalance: 'credit',
    details: [
      detail('accumulated_adjustment', 'Accumulated Adjustment'),
      detail('common_stock', 'Common Stock'),
      detail('estimated_taxes', 'Estimated Taxes'),
      detail('health_insurance_premium', 'Health Insurance Premium'),
      detail('health_savings_account_contribution', 'Health Savings Account Contribution'),
      detail('opening_balance_equity', 'Opening Balance Equity'),
      detail('owners_equity', "Owner's Equity"),
      detail('paid_in_capital_or_surplus', 'Paid-In Capital or Surplus'),
      detail('partner_contributions', 'Partner Contributions'),
      detail('partner_distributions', 'Partner Distributions'),
      detail('partners_equity', "Partner's Equity"),
      detail('personal_expense', 'Personal Expense'),
      detail('personal_income', 'Personal Income'),
      detail('preferred_stock', 'Preferred Stock'),
      detail('retained_earnings', 'Retained Earnings'),
      detail('treasury_stock', 'Treasury Stock'),
      // Beneficial-trust accounting. Taxable K-1 draws — when posted, the
      // Phase 4 rules engine triggers K-1 issuance for the beneficiary.
      detail('trust_distributions_to_beneficiaries', 'Distributions to Beneficiaries'),
    ],
  },

  // ─── Income ────────────────────────────────────────────────────────
  {
    slug: 'income',
    label: 'Income',
    gaapType: 'income',
    normalBalance: 'credit',
    details: [
      detail('discounts_refunds_given', 'Discounts/Refunds Given'),
      detail('non_profit_income', 'Non-Profit Income'),
      detail('other_primary_income', 'Other Primary Income'),
      detail('sales_of_product_income', 'Sales of Product Income'),
      detail('service_fee_income', 'Service/Fee Income'),
      detail('unapplied_cash_payment_income', 'Unapplied Cash Payment Income'),
    ],
  },
  {
    slug: 'other_income',
    label: 'Other Income',
    gaapType: 'income',
    normalBalance: 'credit',
    details: [
      detail('dividend_income', 'Dividend Income'),
      detail('interest_earned', 'Interest Earned'),
      detail('other_investment_income', 'Other Investment Income'),
      detail('other_miscellaneous_income', 'Other Miscellaneous Income'),
      detail('tax_exempt_interest', 'Tax-Exempt Interest'),
      // Practical addition (not in QuickBooks taxonomy): catch-all bucket
      // used by the default seed for account 4999.
      detail('uncategorized_income', 'Uncategorized Income'),
      // Beneficial-trust accounting.
      detail('trust_short_term_capital_gains', 'Short-Term Capital Gains'),
      detail('trust_long_term_capital_gains', 'Long-Term Capital Gains'),
      detail('trust_rental_income_net', 'Rental Income (Net)'),
      detail('trust_equipment_ip_lease_income', 'Equipment & IP Lease Income'),
      detail('trust_personal_use_lease_income', 'Trustee Personal Use Lease Income'),
      detail('trust_royalty_income', 'Royalty Income'),
      detail('trust_business_income', 'Business Income (K-1 Pass-Through)'),
      detail('trust_k1_income', 'K-1 Income'),
    ],
  },

  // ─── COGS / Expenses / Other Expense (all gaap=expense) ────────────
  {
    slug: 'cost_of_goods_sold',
    label: 'Cost of Goods Sold',
    gaapType: 'expense',
    normalBalance: 'debit',
    details: [
      detail('cost_of_goods_sold', 'Cost of Goods Sold (COGS)'),
      detail('cost_of_labor_cos', 'Cost of Labor - COS'),
      detail('equipment_rental_cos', 'Equipment Rental - COS'),
      detail('other_costs_of_services_cos', 'Other Costs of Services - COS'),
      detail('shipping_freight_cos', 'Shipping, Freight & Delivery - COS'),
      detail('supplies_materials_cogs', 'Supplies & Materials - COGS'),
    ],
  },
  {
    slug: 'expenses',
    label: 'Expenses',
    gaapType: 'expense',
    normalBalance: 'debit',
    details: [
      detail('advertising_promotional', 'Advertising/Promotional'),
      detail('auto', 'Auto'),
      detail('bad_debts', 'Bad Debts'),
      detail('bank_charges', 'Bank Charges'),
      detail('charitable_contributions', 'Charitable Contributions'),
      detail('communication', 'Communication'),
      detail('cost_of_labor', 'Cost of Labor'),
      detail('dues_and_subscriptions', 'Dues & Subscriptions'),
      detail('entertainment', 'Entertainment'),
      detail('entertainment_meals', 'Entertainment Meals'),
      detail('equipment_rental', 'Equipment Rental'),
      detail('finance_costs', 'Finance Costs'),
      detail('insurance', 'Insurance'),
      detail('interest_paid', 'Interest Paid'),
      detail('legal_professional_fees', 'Legal & Professional Fees'),
      detail('office_general_admin', 'Office/General Administrative Expenses'),
      detail('other_business_expenses', 'Other Business Expenses'),
      detail('other_miscellaneous_service_cost', 'Other Miscellaneous Service Cost'),
      detail('payroll_expenses', 'Payroll Expenses'),
      detail('payroll_tax_expenses', 'Payroll Tax Expenses'),
      detail('payroll_wage_expenses', 'Payroll Wage Expenses'),
      detail('promotional_meals', 'Promotional Meals'),
      detail('rent_or_lease_buildings', 'Rent or Lease of Buildings'),
      detail('repair_maintenance', 'Repair & Maintenance'),
      detail('shipping_freight_delivery', 'Shipping, Freight & Delivery'),
      detail('supplies_materials', 'Supplies & Materials'),
      detail('taxes_paid', 'Taxes Paid'),
      detail('travel', 'Travel'),
      detail('travel_meals', 'Travel Meals'),
      detail('travel_lodging', 'Travel Lodging'),
      detail('travel_transportation', 'Travel Transportation'),
      detail('unapplied_cash_bill_payment_expense', 'Unapplied Cash Bill Payment Expense'),
      detail('utilities', 'Utilities'),
      // Beneficial-trust accounting. 815/820 are gated by Phase 4 rules:
      // only postable when recipient beneficiary is under 21 OR incapacitated.
      detail('trust_property_taxes', 'Property Taxes'),
      detail('trust_non_property_taxes', 'Non-Property Taxes'),
      detail('trust_trustee_compensation', 'Trustee Compensation (1099)'),
      detail('trust_accounting_tax_prep', 'Accounting & Tax Prep'),
      detail('trust_legal_services', 'Legal Services'),
      detail('trust_professional_services', 'Professional Services'),
      detail('trust_consulting_fees', 'Consulting Fees'),
      detail('trust_medical_wellness', 'Medical & Wellness'),
      detail('trust_fees_permits_services', 'Fees, Permits & Services'),
      detail('trust_insurance_medical_life', 'Insurance - Medical & Life'),
      detail('trust_meals_for_workers', 'Meals for Service Workers'),
      detail('trust_uniforms', 'Uniforms (Trust Logo)'),
      detail('trust_education_training', 'Education & Training'),
      detail('trust_food_minors_incapacitated', 'Food (Minors / Incapacitated)'),
      detail('trust_clothing_minors_incapacitated', 'Clothing (Minors / Incapacitated)'),
    ],
  },
  {
    slug: 'other_expense',
    label: 'Other Expense',
    gaapType: 'expense',
    normalBalance: 'debit',
    details: [
      detail('amortization', 'Amortization'),
      detail('depreciation', 'Depreciation'),
      detail('exchange_gain_or_loss', 'Exchange Gain or Loss'),
      detail('gas_and_fuel', 'Gas and Fuel'),
      detail('home_office', 'Home Office'),
      detail('homeowner_rental_insurance', 'Homeowner Rental Insurance'),
      detail('mortgage_interest_home_office', 'Mortgage Interest Home Office'),
      detail('other_home_office_expenses', 'Other Home Office Expenses'),
      detail('other_miscellaneous_expense', 'Other Miscellaneous Expense'),
      detail('other_vehicle_expenses', 'Other Vehicle Expenses'),
      detail('parking_and_tolls', 'Parking and Tolls'),
      detail('penalties_settlements', 'Penalties & Settlements'),
      detail('property_tax_home_office', 'Property Tax Home Office'),
      detail('rent_and_lease_home_office', 'Rent and Lease Home Office'),
      detail('repairs_and_maintenance_home_office', 'Repairs and Maintenance Home Office'),
      detail('uncategorized_expense', 'Uncategorized Expense'),
      detail('utilities_home_office', 'Utilities Home Office'),
      detail('vehicle', 'Vehicle'),
      detail('vehicle_insurance', 'Vehicle Insurance'),
      detail('vehicle_lease', 'Vehicle Lease'),
      detail('vehicle_loan', 'Vehicle Loan'),
      detail('vehicle_loan_interest', 'Vehicle Loan Interest'),
      detail('vehicle_registration', 'Vehicle Registration'),
      detail('vehicle_repairs', 'Vehicle Repairs'),
      detail('wash_and_road_services', 'Wash and Road Services'),
    ],
  },
] as const;

const ACCOUNT_TYPE_BY_SLUG = new Map<string, AccountTypeDef>(
  ACCOUNT_TYPES.map((t) => [t.slug, t]),
);

export function getAccountType(slug: string): AccountTypeDef | null {
  return ACCOUNT_TYPE_BY_SLUG.get(slug) ?? null;
}

export function getDetail(accountTypeSlug: string, detailSlug: string): CanonicalDetail | null {
  return getAccountType(accountTypeSlug)?.details.find((d) => d.slug === detailSlug) ?? null;
}

export function accountTypesForGaap(gaap: GaapType): AccountTypeDef[] {
  return ACCOUNT_TYPES.filter((t) => t.gaapType === gaap);
}

/**
 * Validate that a (gaap_type, account_type, detail_type) triple is canonical.
 * Returns null if valid, or a string describing what's wrong.
 */
export function validateCoaTriple(args: {
  gaapType: string;
  accountType: string;
  detailType: string;
}): string | null {
  const at = getAccountType(args.accountType);
  if (!at) return `unknown account_type: ${args.accountType}`;
  if (at.gaapType !== args.gaapType) {
    return `account_type ${args.accountType} requires gaap_type=${at.gaapType}, got ${args.gaapType}`;
  }
  if (!at.details.some((d) => d.slug === args.detailType)) {
    return `unknown detail_type ${args.detailType} for account_type ${args.accountType}`;
  }
  return null;
}
