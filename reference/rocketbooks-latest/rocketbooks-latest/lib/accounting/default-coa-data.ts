import { validateCoaTriple, type GaapType } from './coa-taxonomy';

export interface SeedAccount {
  accountNumber: string;
  accountName: string;
  gaapType: GaapType;
  accountType: string;
  detailType: string;
  normalBalance: 'debit' | 'credit';
  // accountNumber of another seed account this nests under. The parent must
  // come earlier in DEFAULT_COA so its id is resolvable when we hit the child.
  parent?: string;
}

/**
 * Standard small-business chart of accounts seeded into every new
 * organization. Every (gaapType, accountType, detailType) triple is a
 * canonical value defined in coa-taxonomy.ts — validated at module-load.
 *
 * No 'server-only' here so it can be imported by CLI scripts (backfill,
 * audits) in addition to the server-only seedDefaultCoa runner.
 *
 * Bank/credit-card sub-accounts and statement-imported COAs are auto-created
 * by autoCreateBankCoa / resolveStatementCoa, not seeded.
 */
export const DEFAULT_COA: SeedAccount[] = [
  // ─── Assets (1xxx) ─────────────────────────────────────────────────
  { accountNumber: '1000', accountName: 'Cash on Hand',          gaapType: 'asset', accountType: 'bank',                 detailType: 'cash_on_hand',         normalBalance: 'debit' },
  { accountNumber: '1010', accountName: 'Checking',              gaapType: 'asset', accountType: 'bank',                 detailType: 'checking',             normalBalance: 'debit' },
  { accountNumber: '1020', accountName: 'Savings',               gaapType: 'asset', accountType: 'bank',                 detailType: 'savings',              normalBalance: 'debit' },
  { accountNumber: '1100', accountName: 'Accounts Receivable',   gaapType: 'asset', accountType: 'accounts_receivable',  detailType: 'accounts_receivable',  normalBalance: 'debit' },
  { accountNumber: '1200', accountName: 'Prepaid Expenses',      gaapType: 'asset', accountType: 'other_current_assets', detailType: 'prepaid_expenses',     normalBalance: 'debit' },
  { accountNumber: '1210', accountName: 'Undeposited Funds',     gaapType: 'asset', accountType: 'other_current_assets', detailType: 'undeposited_funds',    normalBalance: 'debit' },
  { accountNumber: '1500', accountName: 'Furniture & Fixtures',  gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'furniture_fixtures',   normalBalance: 'debit' },
  { accountNumber: '1510', accountName: 'Machinery & Equipment', gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'machinery_equipment',  normalBalance: 'debit' },
  { accountNumber: '1520', accountName: 'Vehicles',              gaapType: 'asset', accountType: 'fixed_assets',         detailType: 'vehicles',             normalBalance: 'debit' },

  // ─── Liabilities (2xxx) ────────────────────────────────────────────
  { accountNumber: '2000', accountName: 'Accounts Payable',     gaapType: 'liability', accountType: 'accounts_payable',          detailType: 'accounts_payable',    normalBalance: 'credit' },
  { accountNumber: '2100', accountName: 'Credit Card',          gaapType: 'liability', accountType: 'credit_card',               detailType: 'credit_card',         normalBalance: 'credit' },
  { accountNumber: '2200', accountName: 'Sales Tax Payable',    gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'sales_tax_payable',   normalBalance: 'credit' },
  { accountNumber: '2210', accountName: 'Payroll Tax Payable',  gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'payroll_tax_payable', normalBalance: 'credit' },
  { accountNumber: '2220', accountName: 'Deferred Revenue',     gaapType: 'liability', accountType: 'other_current_liabilities', detailType: 'deferred_revenue',    normalBalance: 'credit' },
  { accountNumber: '2500', accountName: 'Notes Payable',        gaapType: 'liability', accountType: 'long_term_liabilities',     detailType: 'notes_payable',       normalBalance: 'credit' },

  // ─── Equity (3xxx) ─────────────────────────────────────────────────
  { accountNumber: '3000', accountName: "Owner's Equity",    gaapType: 'equity', accountType: 'equity', detailType: 'owners_equity',     normalBalance: 'credit' },
  // Personal Expense / Personal Income are owner draw / owner contribution
  // slots. Plaid PFCs flagged as personal (medical, childcare, gym, gambling,
  // etc. on a business account) book here so they don't pollute the P&L.
  // Normal balance per QuickBooks convention: Personal Expense is a debit-side
  // contra-equity (reduces equity), Personal Income is credit-side.
  { accountNumber: '3050', accountName: 'Personal Expense',  gaapType: 'equity', accountType: 'equity', detailType: 'personal_expense',  normalBalance: 'debit'  },
  { accountNumber: '3060', accountName: 'Personal Income',   gaapType: 'equity', accountType: 'equity', detailType: 'personal_income',   normalBalance: 'credit' },
  { accountNumber: '3100', accountName: 'Retained Earnings', gaapType: 'equity', accountType: 'equity', detailType: 'retained_earnings', normalBalance: 'credit' },

  // ─── Income (4xxx) ─────────────────────────────────────────────────
  { accountNumber: '4000', accountName: 'Sales of Product Income',     gaapType: 'income', accountType: 'income',       detailType: 'sales_of_product_income',    normalBalance: 'credit' },
  { accountNumber: '4100', accountName: 'Service/Fee Income',          gaapType: 'income', accountType: 'income',       detailType: 'service_fee_income',         normalBalance: 'credit' },
  { accountNumber: '4200', accountName: 'Interest Earned',             gaapType: 'income', accountType: 'other_income', detailType: 'interest_earned',            normalBalance: 'credit' },
  { accountNumber: '4300', accountName: 'Other Miscellaneous Income',  gaapType: 'income', accountType: 'other_income', detailType: 'other_miscellaneous_income', normalBalance: 'credit' },
  { accountNumber: '4999', accountName: 'Uncategorized Income',        gaapType: 'income', accountType: 'other_income', detailType: 'uncategorized_income',       normalBalance: 'credit' },

  // ─── COGS (5xxx) — gaap=expense ────────────────────────────────────
  { accountNumber: '5000', accountName: 'Supplies & Materials (COGS)',           gaapType: 'expense', accountType: 'cost_of_goods_sold', detailType: 'supplies_materials_cogs', normalBalance: 'debit' },
  { accountNumber: '5100', accountName: 'Shipping, Freight & Delivery (COGS)',   gaapType: 'expense', accountType: 'cost_of_goods_sold', detailType: 'shipping_freight_cos',    normalBalance: 'debit' },
  { accountNumber: '5200', accountName: 'Cost of Labor (COGS)',                  gaapType: 'expense', accountType: 'cost_of_goods_sold', detailType: 'cost_of_labor_cos',       normalBalance: 'debit' },
  { accountNumber: '5999', accountName: 'Uncategorized Expense',                 gaapType: 'expense', accountType: 'other_expense',      detailType: 'uncategorized_expense',   normalBalance: 'debit' },

  // ─── Operating expenses (6xxx) — gaap=expense, accountType=expenses
  { accountNumber: '6000', accountName: 'Meals',                gaapType: 'expense', accountType: 'expenses', detailType: 'entertainment',         normalBalance: 'debit' },
  { accountNumber: '6010', accountName: 'Entertainment Meals',  gaapType: 'expense', accountType: 'expenses', detailType: 'entertainment_meals',   normalBalance: 'debit', parent: '6000' },
  { accountNumber: '6020', accountName: 'Promotional Meals',    gaapType: 'expense', accountType: 'expenses', detailType: 'promotional_meals',     normalBalance: 'debit', parent: '6000' },
  { accountNumber: '6030', accountName: 'Travel Meals',         gaapType: 'expense', accountType: 'expenses', detailType: 'travel_meals',          normalBalance: 'debit', parent: '6000' },

  { accountNumber: '6100', accountName: 'Travel',         gaapType: 'expense', accountType: 'expenses', detailType: 'travel',                 normalBalance: 'debit' },
  { accountNumber: '6110', accountName: 'Lodging',        gaapType: 'expense', accountType: 'expenses', detailType: 'travel_lodging',         normalBalance: 'debit', parent: '6100' },
  { accountNumber: '6120', accountName: 'Transportation', gaapType: 'expense', accountType: 'expenses', detailType: 'travel_transportation',  normalBalance: 'debit', parent: '6100' },

  { accountNumber: '6200', accountName: 'Advertising/Promotional',          gaapType: 'expense', accountType: 'expenses', detailType: 'advertising_promotional',   normalBalance: 'debit' },
  { accountNumber: '6250', accountName: 'Dues & Subscriptions',             gaapType: 'expense', accountType: 'expenses', detailType: 'dues_and_subscriptions',    normalBalance: 'debit' },
  { accountNumber: '6300', accountName: 'Office/General Administrative',    gaapType: 'expense', accountType: 'expenses', detailType: 'office_general_admin',      normalBalance: 'debit' },
  { accountNumber: '6400', accountName: 'Insurance',                        gaapType: 'expense', accountType: 'expenses', detailType: 'insurance',                  normalBalance: 'debit' },
  { accountNumber: '6500', accountName: 'Legal & Professional Fees',        gaapType: 'expense', accountType: 'expenses', detailType: 'legal_professional_fees',    normalBalance: 'debit' },
  { accountNumber: '6600', accountName: 'Utilities',                        gaapType: 'expense', accountType: 'expenses', detailType: 'utilities',                  normalBalance: 'debit' },
  { accountNumber: '6700', accountName: 'Rent or Lease of Buildings',       gaapType: 'expense', accountType: 'expenses', detailType: 'rent_or_lease_buildings',    normalBalance: 'debit' },
  { accountNumber: '6800', accountName: 'Supplies & Materials',             gaapType: 'expense', accountType: 'expenses', detailType: 'supplies_materials',         normalBalance: 'debit' },
  { accountNumber: '6900', accountName: 'Repairs & Maintenance',            gaapType: 'expense', accountType: 'expenses', detailType: 'repair_maintenance',         normalBalance: 'debit' },

  { accountNumber: '7000', accountName: 'Bank Charges',         gaapType: 'expense', accountType: 'expenses', detailType: 'bank_charges',         normalBalance: 'debit' },
  { accountNumber: '7100', accountName: 'Payroll Expenses',     gaapType: 'expense', accountType: 'expenses', detailType: 'payroll_expenses',     normalBalance: 'debit' },
  { accountNumber: '7200', accountName: 'Payroll Tax Expenses', gaapType: 'expense', accountType: 'expenses', detailType: 'payroll_tax_expenses', normalBalance: 'debit' },

  // ─── Other expenses (8xxx) — gaap=expense, accountType=other_expense
  { accountNumber: '8000', accountName: 'Depreciation',                 gaapType: 'expense', accountType: 'other_expense', detailType: 'depreciation',                normalBalance: 'debit' },
  { accountNumber: '8100', accountName: 'Amortization',                 gaapType: 'expense', accountType: 'other_expense', detailType: 'amortization',                normalBalance: 'debit' },
  { accountNumber: '8200', accountName: 'Other Miscellaneous Expense',  gaapType: 'expense', accountType: 'other_expense', detailType: 'other_miscellaneous_expense', normalBalance: 'debit' },
];

// Module-load guard: every entry must reference canonical taxonomy values.
// Catches typos at boot rather than at first new-org creation.
for (const a of DEFAULT_COA) {
  const err = validateCoaTriple({ gaapType: a.gaapType, accountType: a.accountType, detailType: a.detailType });
  if (err) throw new Error(`DEFAULT_COA invariant violated for ${a.accountNumber} ${a.accountName}: ${err}`);
}
