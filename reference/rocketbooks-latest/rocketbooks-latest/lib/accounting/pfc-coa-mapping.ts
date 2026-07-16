/**
 * Plaid Personal Finance Category (PFCv2) → Chart-of-Accounts mapping.
 *
 * Source data: pfc-taxonomy-all.csv (Plaid's published taxonomy). Each Plaid
 * transaction includes personal_finance_category.detailed — we use that key
 * to pre-fill the categorization at promotion time.
 *
 * Mapping principles (per the spec the user shared):
 *   1. Map by GAAP. Each PFC lands on a (account_type, detail_type) pair from
 *      coa-taxonomy.ts so the result is canonical and auditable.
 *   2. Anything that doesn't fit GAAP cleanly:
 *        - Clearly personal (medical, gym, child support, casinos, etc. on
 *          a business account) → equity / personal_expense or personal_income.
 *          These flow through owner's-draw / owner's-contribution.
 *        - Genuinely unclassifiable → other_expense / uncategorized_expense
 *          (or other_income / uncategorized_income).
 *   3. PFCv1 + PFCv2 descriptions are retained on each entry. Used later to
 *      template clarifying questions to the user (e.g. "Was this a personal
 *      Venmo or a customer payment?").
 *
 * No 'server-only' — this is pure data, importable by client components,
 * scripts, and server code.
 */

import { validateCoaTriple, getAccountType, getDetail } from './coa-taxonomy';

/**
 * Conceptual classification — drives downstream behavior:
 *   - business_expense: expense P&L impact
 *   - business_income: revenue P&L impact
 *   - personal: owner draw / owner contribution (equity, no P&L)
 *   - liability_paydown: paying down a liability (no P&L; balance sheet only)
 *   - liability_increase: borrowing (no P&L)
 *   - asset_movement: transfer between bank/asset accounts (no P&L)
 *   - transfer_review: ambiguous transfer that should prompt user review
 *   - uncategorized: catch-all
 */
export type PfcClassification =
  | 'business_expense'
  | 'business_income'
  | 'personal'
  | 'liability_paydown'
  | 'liability_increase'
  | 'asset_movement'
  | 'transfer_review'
  | 'uncategorized';

export interface PfcMapping {
  /** PFCv2 primary, e.g. "FOOD_AND_DRINK". */
  pfcPrimary: string;
  /** PFCv2 detailed, e.g. "FOOD_AND_DRINK_RESTAURANT". This is the lookup key. */
  pfcDetailed: string;
  /** Canonical account_type slug from coa-taxonomy.ts (e.g. "expenses"). */
  accountType: string;
  /** Canonical detail_type slug from coa-taxonomy.ts (e.g. "entertainment_meals"). */
  detailType: string;
  classification: PfcClassification;
  /** Plaid's PFCv2 description. Useful for templating user-facing questions. */
  descriptionV2: string;
  /** Plaid's PFCv1 description if a v1 mapping exists, else null. */
  descriptionV1: string | null;
  /** Optional accountant note explaining the mapping. */
  note?: string;
}

const M = (
  pfcPrimary: string,
  pfcDetailed: string,
  accountType: string,
  detailType: string,
  classification: PfcClassification,
  descriptionV2: string,
  descriptionV1: string | null = null,
  note?: string,
): PfcMapping => ({ pfcPrimary, pfcDetailed, accountType, detailType, classification, descriptionV2, descriptionV1, note });

export const PFC_COA_MAPPINGS: readonly PfcMapping[] = [
  // ─── INCOME ─────────────────────────────────────────────────────────
  M('INCOME', 'INCOME_CHILD_SUPPORT',          'equity',       'personal_income',           'personal',        "Court-ordered child-support payments to a parent.", null,
    'Personal — child support is not business income; flows through owner draw/contribution.'),
  M('INCOME', 'INCOME_CONTRACTOR',             'income',       'service_fee_income',        'business_income', 'Income from freelance or independent contract work.', null),
  M('INCOME', 'INCOME_DIVIDENDS',              'other_income', 'other_miscellaneous_income','business_income', 'Income from dividends', 'Income from dividends',
    'No specific dividend slot in default seed; lands in Other Misc Income.'),
  M('INCOME', 'INCOME_GIG_ECONOMY',            'income',       'service_fee_income',        'business_income', 'Money earned by working in the gig economy (Uber, Lyft, etc.)', null),
  M('INCOME', 'INCOME_INTEREST_EARNED',        'other_income', 'interest_earned',           'business_income', 'Income from interest on savings accounts', 'Income from interest on savings accounts'),
  M('INCOME', 'INCOME_LONG_TERM_DISABILITY',   'equity',       'personal_income',           'personal',        'Disability payments (e.g. social security).', null),
  M('INCOME', 'INCOME_MILITARY',               'equity',       'personal_income',           'personal',        'Veterans benefits.', null),
  M('INCOME', 'INCOME_RENTAL',                 'income',       'service_fee_income',        'business_income', 'Rental income (property, lease, Airbnb/VRBO).', null,
    'Treat as service revenue; orgs that rent properties as a business will recognize revenue here.'),
  M('INCOME', 'INCOME_RETIREMENT_PENSION',     'equity',       'personal_income',           'personal',        'SSA, 401k, pension distributions', 'Income from pension payments'),
  M('INCOME', 'INCOME_SALARY',                 'equity',       'personal_income',           'personal',        'Income from salaries and wages',     'Income from salaries, gig work, tips',
    'Owner-salary deposits route to personal income; W-2 wages on a business account is unusual.'),
  M('INCOME', 'INCOME_TAX_REFUND',             'other_income', 'other_miscellaneous_income','business_income', 'Government tax refund provided to the user', 'Income from tax refunds'),
  M('INCOME', 'INCOME_UNEMPLOYMENT',           'equity',       'personal_income',           'personal',        'Money earned from unemployment benefits', 'Unemployment benefits incl. healthcare'),
  M('INCOME', 'INCOME_OTHER',                  'other_income', 'uncategorized_income',      'uncategorized',   'Other miscellaneous income', null),

  // ─── LOAN_DISBURSEMENTS (incoming loan proceeds) ────────────────────
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_AUTO',                  'long_term_liabilities', 'notes_payable', 'liability_increase', 'Auto loan disbursements', null),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_CASH_ADVANCES',         'long_term_liabilities', 'notes_payable', 'liability_increase', 'Payday loans and cash advances', null),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_EWA',                   'long_term_liabilities', 'notes_payable', 'liability_increase', 'Early wage access disbursements from integrated payroll providers.', null),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_MORTGAGE',              'long_term_liabilities', 'notes_payable', 'liability_increase', 'Mortgage loan disbursements', null),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_PERSONAL',              'long_term_liabilities', 'notes_payable', 'liability_increase', 'Personal loan disbursements (secured or unsecured).', null),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_STUDENT',               'equity',                'personal_income','personal',          'Student loan disbursements.', null,
    'Student loans on a business account are personal; route to owner contribution.'),
  M('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT',    'long_term_liabilities', 'notes_payable', 'liability_increase', 'Other miscellaneous loan disbursements', 'Loans/cash advances deposited into a bank account'),

  // ─── LOAN_PAYMENTS (paying down liabilities) ────────────────────────
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_BNPL',                  'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Loan payments for buy-now-pay-later (BNPL) services.', null),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT',           'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Payments on car loans and leases.', 'Payments on car loans and leases.'),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CASH_ADVANCES',         'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Loan payments for cash advances.', null),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',   'credit_card',           'credit_card',   'liability_paydown', 'Payments made to a credit card account.', 'Payments made to a credit card account.'),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_EWA',                   'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Loan payments for early wage access from integrated payroll providers.', null),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',      'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Payments on mortgages', 'Payments on mortgages'),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'equity',                'personal_expense','personal',        'Payments on personal loans.', 'Personal loans, including cash advances and BNPL repayments.',
    'Personal context — book as owner draw rather than reduce a business liability.'),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',  'equity',                'personal_expense','personal',        'Payments on student loans. For tuition, see GENERAL_SERVICES_EDUCATION.', 'Payments on student loans.'),
  M('LOAN_PAYMENTS', 'LOAN_PAYMENTS_OTHER_PAYMENT',         'long_term_liabilities', 'notes_payable', 'liability_paydown', 'Other miscellaneous debt payments', 'Other miscellaneous debt payments'),

  // ─── TRANSFER_IN ────────────────────────────────────────────────────
  M('TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER',                 'bank',         'checking',                 'asset_movement',   'General inbound transfers from another account', 'General inbound transfers from another account',
    'Internal transfer between user\'s own accounts; both sides are bank assets.'),
  M('TRANSFER_IN', 'TRANSFER_IN_DEPOSIT',                          'other_current_assets', 'undeposited_funds','asset_movement', 'Cash, checks, and ATM deposits into a bank account', 'Cash, checks, and ATM deposits into a bank account'),
  M('TRANSFER_IN', 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',  'equity',       'personal_income',          'personal',         'Money transferred in from an investment or retirement account', 'Inbound transfers to an investment or retirement account'),
  M('TRANSFER_IN', 'TRANSFER_IN_SAVINGS',                          'bank',         'savings',                  'asset_movement',   'Inbound transfers to a savings account', 'Inbound transfers to a savings account'),
  M('TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS',            'other_income', 'uncategorized_income',     'transfer_review',  'Money transferred in from another application (Venmo/Cashapp/Zelle).', null,
    'Could be a customer payment OR personal — flag for review.'),
  M('TRANSFER_IN', 'TRANSFER_IN_WIRE',                             'other_income', 'uncategorized_income',     'transfer_review',  'Wire transfer received from another bank.', null,
    'Wires can be revenue or owner contribution; review.'),
  M('TRANSFER_IN', 'TRANSFER_IN_OTHER_TRANSFER_IN',                'other_income', 'uncategorized_income',     'transfer_review',  'Other miscellaneous inbound transactions', 'Other miscellaneous inbound transactions'),

  // ─── TRANSFER_OUT ───────────────────────────────────────────────────
  M('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER',                 'bank',          'checking',                  'asset_movement',  'General outbound transfers to another account', 'General outbound transfers to another account'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_CRYPTO',                           'equity',        'personal_expense',          'personal',        'Outbound transfers of cryptocurrency', null,
    'Crypto purchases on a business account are typically owner draw / personal.'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',  'equity',        'personal_expense',          'personal',        'Transfers to an investment or retirement account (Acorns, Betterment, etc.)', 'Transfers to an investment or retirement account (Acorns, Betterment, etc.)'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS',                          'bank',          'savings',                   'asset_movement',  'Outbound transfers to savings accounts', 'Outbound transfers to savings accounts'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS',           'other_expense', 'uncategorized_expense',     'transfer_review', 'Money transferred out of the account into another application.', null,
    'Could be a vendor payment via Venmo/Cashapp OR personal — flag for review.'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_WIRE',                             'other_expense', 'uncategorized_expense',     'transfer_review', 'Wire transfer sent to another bank.', null),
  M('TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL',                       'equity',        'personal_expense',          'personal',        'Withdrawals from a bank account', 'Withdrawals from a bank account',
    'Cash withdrawals from a business account are typically owner draw.'),
  M('TRANSFER_OUT', 'TRANSFER_OUT_OTHER_TRANSFER_OUT',               'other_expense', 'uncategorized_expense',     'transfer_review', 'Other miscellaneous outbound transactions', 'Other miscellaneous outbound transactions'),

  // ─── BANK_FEES ──────────────────────────────────────────────────────
  M('BANK_FEES', 'BANK_FEES_ATM_FEES',                  'expenses', 'bank_charges', 'business_expense', 'Fees incurred for out-of-network ATMs', 'Fees incurred for out-of-network ATMs'),
  M('BANK_FEES', 'BANK_FEES_INSUFFICIENT_FUNDS',        'expenses', 'bank_charges', 'business_expense', 'Fees relating to insufficient funds', 'Fees relating to insufficient funds'),
  M('BANK_FEES', 'BANK_FEES_INTEREST_CHARGE',           'expenses', 'bank_charges', 'business_expense', 'Fees incurred for interest on purchases (excludes cash-advance interest)', 'Fees incurred for interest on purchases, including not-paid-in-full or cash-advance interest'),
  M('BANK_FEES', 'BANK_FEES_FOREIGN_TRANSACTION_FEES',  'expenses', 'bank_charges', 'business_expense', 'Fees incurred on non-domestic transactions', 'Fees incurred on non-domestic transactions'),
  M('BANK_FEES', 'BANK_FEES_OVERDRAFT_FEES',            'expenses', 'bank_charges', 'business_expense', 'Penalty payment for overdrafts', 'Fees incurred when an account is in overdraft'),
  M('BANK_FEES', 'BANK_FEES_LATE_FEES',                 'expenses', 'bank_charges', 'business_expense', 'Penalty payment for late payment', null),
  M('BANK_FEES', 'BANK_FEES_CASH_ADVANCE',              'expenses', 'bank_charges', 'business_expense', 'Fees for withdrawing cash on a credit card (transaction + interest fees).', null),
  M('BANK_FEES', 'BANK_FEES_OTHER_BANK_FEES',           'expenses', 'bank_charges', 'business_expense', 'Other miscellaneous bank fees, including annual fee', 'Other miscellaneous bank fees, including annual fee'),

  // ─── ENTERTAINMENT ──────────────────────────────────────────────────
  M('ENTERTAINMENT', 'ENTERTAINMENT_CASINOS_AND_GAMBLING',                    'equity',   'personal_expense',         'personal',         'Gambling, casinos, and sports betting', 'Gambling, casinos, and sports betting',
    'Gambling losses are not a business deduction; route to owner draw.'),
  M('ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO',                         'expenses', 'dues_and_subscriptions',   'business_expense', 'Digital and in-person music purchases (incl. streaming services)', 'Digital and in-person music purchases (incl. streaming services)'),
  M('ENTERTAINMENT', 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS', 'expenses', 'entertainment',         'business_expense', 'Purchases at sporting events, music venues, concerts, museums, and amusement parks', 'Purchases at sporting events, music venues, concerts, museums, and amusement parks',
    'Could be client entertainment; if personal, recategorize to personal_expense.'),
  M('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES',                           'expenses', 'dues_and_subscriptions',   'business_expense', 'In-home movie streaming services and movie theaters', 'In-home movie streaming services and movie theaters'),
  M('ENTERTAINMENT', 'ENTERTAINMENT_VIDEO_GAMES',                             'equity',   'personal_expense',         'personal',         'Digital and in-person video game purchases', 'Digital and in-person video game purchases'),
  M('ENTERTAINMENT', 'ENTERTAINMENT_OTHER_ENTERTAINMENT',                     'expenses', 'entertainment',            'business_expense', 'Other miscellaneous entertainment purchases (incl. nightlife)', 'Other miscellaneous entertainment purchases (incl. nightlife)'),

  // ─── FOOD_AND_DRINK ─────────────────────────────────────────────────
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR',     'expenses', 'entertainment_meals',  'business_expense', 'Beer, wine, and liquor stores.', 'Beer, wine, and liquor stores.'),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE',                   'expenses', 'entertainment_meals',  'business_expense', 'Purchases at coffee shops or cafes', 'Purchases at coffee shops or cafes'),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD',                'expenses', 'entertainment_meals',  'business_expense', 'Dining expenses for fast food chains', 'Dining expenses for fast food chains'),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES',                'equity',   'personal_expense',     'personal',         "Purchases for fresh produce and groceries, including farmers' markets", "Purchases for fresh produce and groceries, including farmers' markets"),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT',               'expenses', 'entertainment_meals',  'business_expense', 'Dining expenses for restaurants, bars, gastropubs, and diners', 'Dining expenses for restaurants, bars, gastropubs, and diners'),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_VENDING_MACHINES',         'expenses', 'travel_meals',         'business_expense', 'Purchases made at vending-machine operators', 'Purchases made at vending-machine operators'),
  M('FOOD_AND_DRINK', 'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK',     'expenses', 'entertainment_meals',  'business_expense', 'Other miscellaneous food and drink (desserts, juice bars, delis)', 'Other miscellaneous food and drink (desserts, juice bars, delis)'),

  // ─── GENERAL_MERCHANDISE ────────────────────────────────────────────
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS', 'expenses', 'dues_and_subscriptions',   'business_expense', 'Books, magazines, and news', 'Books, magazines, and news'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', 'equity',   'personal_expense',         'personal',         'Apparel, shoes, and jewelry', 'Apparel, shoes, and jewelry',
    'Most clothing on a business account is personal; uniforms can be reclassified.'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CONVENIENCE_STORES',       'expenses', 'supplies_materials',       'business_expense', 'Purchases at convenience stores', 'Purchases at convenience stores'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_DEPARTMENT_STORES',        'expenses', 'supplies_materials',       'business_expense', 'Department stores', 'Department stores'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_DISCOUNT_STORES',          'expenses', 'supplies_materials',       'business_expense', 'Stores selling goods at a discounted price', 'Stores selling goods at a discounted price'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ELECTRONICS',              'expenses', 'office_general_admin',     'business_expense', 'Electronics stores and websites', 'Electronics stores and websites'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES',      'expenses', 'advertising_promotional',  'business_expense', 'Photo, gifts, cards, and floral stores', 'Photo, gifts, cards, and floral stores',
    'Client gifts qualify as advertising/promotional; personal gifts should be recategorized.'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_OFFICE_SUPPLIES',          'expenses', 'office_general_admin',     'business_expense', 'Stores that specialize in office goods', 'Stores that specialize in office goods'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',      'expenses', 'supplies_materials',       'business_expense', 'Multi-purpose e-commerce platforms (Etsy, eBay, Amazon)', 'Multi-purpose e-commerce platforms (Etsy, eBay, Amazon)'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_PET_SUPPLIES',             'equity',   'personal_expense',         'personal',         'Pet supplies and pet food', 'Pet supplies and pet food'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SPORTING_GOODS',           'equity',   'personal_expense',         'personal',         'Sporting goods, camping gear, and outdoor equipment', 'Sporting goods, camping gear, and outdoor equipment'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES',              'expenses', 'supplies_materials',       'business_expense', 'Superstores (Target, Walmart) selling groceries and general merchandise', 'Superstores (Target, Walmart) selling groceries and general merchandise'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_TOBACCO_AND_VAPE',         'equity',   'personal_expense',         'personal',         'Purchases for tobacco and vaping products', 'Purchases for tobacco and vaping products'),
  M('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE','expenses', 'supplies_materials',       'business_expense', 'Other miscellaneous merchandise (toys, hobbies, arts and crafts)', 'Other miscellaneous merchandise (toys, hobbies, arts and crafts)'),

  // ─── HOME_IMPROVEMENT (defaults personal; contractors/landlords reclassify) ──
  M('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_FURNITURE',              'equity', 'personal_expense', 'personal', 'Furniture, bedding, and home accessories', 'Furniture, bedding, and home accessories'),
  M('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_HARDWARE',               'equity', 'personal_expense', 'personal', 'Building materials, hardware stores, paint, and wallpaper', 'Building materials, hardware stores, paint, and wallpaper',
    'Construction businesses should reclassify to supplies_materials_cogs.'),
  M('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE', 'equity', 'personal_expense', 'personal', 'Plumbing, lighting, gardening, and roofing', 'Plumbing, lighting, gardening, and roofing'),
  M('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_SECURITY',               'equity', 'personal_expense', 'personal', 'Home security system purchases', 'Home security system purchases'),
  M('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT', 'equity', 'personal_expense', 'personal', 'Other miscellaneous home purchases (pool installation, pest control)', 'Other miscellaneous home purchases (pool installation, pest control)'),

  // ─── MEDICAL (always personal on a business account) ───────────────
  M('MEDICAL', 'MEDICAL_DENTAL_CARE',                'equity', 'personal_expense', 'personal', 'Dentists and general dental care', 'Dentists and general dental care'),
  M('MEDICAL', 'MEDICAL_EYE_CARE',                   'equity', 'personal_expense', 'personal', 'Optometrists, contacts, and glasses stores', 'Optometrists, contacts, and glasses stores'),
  M('MEDICAL', 'MEDICAL_NURSING_CARE',               'equity', 'personal_expense', 'personal', 'Nursing care and facilities', 'Nursing care and facilities'),
  M('MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'equity', 'personal_expense', 'personal', 'Pharmacies and nutrition shops', 'Pharmacies and nutrition shops'),
  M('MEDICAL', 'MEDICAL_PRIMARY_CARE',               'equity', 'personal_expense', 'personal', 'Doctors and physicians', 'Doctors and physicians'),
  M('MEDICAL', 'MEDICAL_VETERINARY_SERVICES',        'equity', 'personal_expense', 'personal', 'Prevention and care procedures for animals', 'Prevention and care procedures for animals'),
  M('MEDICAL', 'MEDICAL_OTHER_MEDICAL',              'equity', 'personal_expense', 'personal', 'Other miscellaneous medical (blood work, hospitals, ambulances)', 'Other miscellaneous medical (blood work, hospitals, ambulances)'),

  // ─── PERSONAL_CARE (always personal) ───────────────────────────────
  M('PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'equity', 'personal_expense', 'personal', 'Gyms, fitness centers, and workout classes', 'Gyms, fitness centers, and workout classes'),
  M('PERSONAL_CARE', 'PERSONAL_CARE_HAIR_AND_BEAUTY',          'equity', 'personal_expense', 'personal', 'Manicures, haircuts, waxing, spa/massages, and bath/beauty products', 'Manicures, haircuts, waxing, spa/massages, and bath/beauty products'),
  M('PERSONAL_CARE', 'PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING', 'equity', 'personal_expense', 'personal', 'Wash and fold, and dry cleaning expenses', 'Wash and fold, and dry cleaning expenses'),
  M('PERSONAL_CARE', 'PERSONAL_CARE_OTHER_PERSONAL_CARE',      'equity', 'personal_expense', 'personal', 'Other miscellaneous personal care (incl. mental health apps)', 'Other miscellaneous personal care (incl. mental health apps)'),

  // ─── GENERAL_SERVICES ──────────────────────────────────────────────
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING', 'expenses', 'legal_professional_fees', 'business_expense', 'Financial planning, tax, and accounting services.', 'Financial planning, tax, and accounting services.'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_AUTOMOTIVE',                        'expenses', 'repair_maintenance',      'business_expense', 'Oil changes, car washes, repairs, and towing', 'Oil changes, car washes, repairs, and towing'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE',                         'equity',   'personal_expense',        'personal',         'Babysitters and daycare', 'Babysitters and daycare'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_CONSULTING_AND_LEGAL',              'expenses', 'legal_professional_fees', 'business_expense', 'Consulting and legal services', 'Consulting and legal services'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_EDUCATION',                         'expenses', 'dues_and_subscriptions',  'business_expense', 'Elementary, high school, professional schools, and college tuition', 'Elementary, high school, professional schools, and college tuition',
    'Business training/CEU is deductible; personal tuition should be reclassified to personal_expense.'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE',                         'expenses', 'insurance',               'business_expense', 'Insurance for auto, home, and healthcare', 'Insurance for auto, home, and healthcare'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',              'cost_of_goods_sold', 'shipping_freight_cos','business_expense','Mail, packaging, and shipping services', 'Mail, packaging, and shipping services'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_STORAGE',                           'expenses', 'rent_or_lease_buildings', 'business_expense', 'Storage services and facilities', 'Storage services and facilities'),
  M('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES',            'expenses', 'office_general_admin',    'business_expense', 'Other miscellaneous services (advertising, cloud storage)', 'Other miscellaneous services (advertising, cloud storage)'),

  // ─── GOVERNMENT_AND_NON_PROFIT ─────────────────────────────────────
  M('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_DONATIONS',                      'other_expense', 'other_miscellaneous_expense', 'business_expense', 'Charitable, political, and religious donations', 'Charitable, political, and religious donations',
    'Default seed has no charitable_contributions account; orgs that donate frequently should add one.'),
  M('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES','expenses', 'office_general_admin',     'business_expense', 'Government departments and agencies (license/passport renewal etc.)', 'Government departments and agencies (license/passport renewal etc.)'),
  M('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT',                    'equity',   'personal_expense',         'personal',         'Tax payments, including income and property taxes', 'Tax payments, including income and property taxes',
    'For pass-through LLCs, owner income tax is personal; for C-corps, route to a tax_expense account if added.'),
  M('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT','expenses', 'office_general_admin',     'business_expense', 'Other miscellaneous government and non-profit agencies', 'Other miscellaneous government and non-profit agencies'),

  // ─── TRANSPORTATION (auto/transit business expense) ────────────────
  M('TRANSPORTATION', 'TRANSPORTATION_BIKES_AND_SCOOTERS',     'expenses', 'travel_transportation', 'business_expense', 'Bike and scooter rentals', 'Bike and scooter rentals'),
  M('TRANSPORTATION', 'TRANSPORTATION_GAS',                    'expenses', 'travel_transportation', 'business_expense', 'Purchases at a gas station', 'Purchases at a gas station'),
  M('TRANSPORTATION', 'TRANSPORTATION_PARKING',                'expenses', 'travel_transportation', 'business_expense', 'Parking fees and expenses', 'Parking fees and expenses'),
  M('TRANSPORTATION', 'TRANSPORTATION_PUBLIC_TRANSIT',         'expenses', 'travel_transportation', 'business_expense', 'Public transportation (rail, train, buses, metro)', 'Public transportation (rail, train, buses, metro)'),
  M('TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',  'expenses', 'travel_transportation', 'business_expense', 'Taxi and ride-share services', 'Taxi and ride-share services'),
  M('TRANSPORTATION', 'TRANSPORTATION_TOLLS',                  'expenses', 'travel_transportation', 'business_expense', 'Toll expenses', 'Toll expenses'),
  M('TRANSPORTATION', 'TRANSPORTATION_OTHER_TRANSPORTATION',   'expenses', 'travel_transportation', 'business_expense', 'Other miscellaneous transportation expenses', 'Other miscellaneous transportation expenses'),

  // ─── TRAVEL ────────────────────────────────────────────────────────
  M('TRAVEL', 'TRAVEL_FLIGHTS',       'expenses', 'travel',                'business_expense', 'Airline expenses', 'Airline expenses'),
  M('TRAVEL', 'TRAVEL_LODGING',       'expenses', 'travel_lodging',        'business_expense', 'Hotels, motels, and hosted accommodation (Airbnb)', 'Hotels, motels, and hosted accommodation (Airbnb)'),
  M('TRAVEL', 'TRAVEL_RENTAL_CARS',   'expenses', 'travel_transportation', 'business_expense', 'Rental cars, charter buses, and trucks', 'Rental cars, charter buses, and trucks'),
  M('TRAVEL', 'TRAVEL_OTHER_TRAVEL',  'expenses', 'travel',                'business_expense', 'Other miscellaneous travel expenses', 'Other miscellaneous travel expenses'),

  // ─── RENT_AND_UTILITIES ────────────────────────────────────────────
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',        'expenses', 'utilities',                'business_expense', 'Gas and electricity bills', 'Gas and electricity bills'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE',         'expenses', 'utilities',                'business_expense', 'Internet and cable bills', 'Internet and cable bills'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT',                       'expenses', 'rent_or_lease_buildings',  'business_expense', 'Rent payment', 'Rent payment'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT','expenses', 'utilities',                'business_expense', 'Sewage and garbage disposal bills', 'Sewage and garbage disposal bills'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE',                  'expenses', 'utilities',                'business_expense', 'Telephone bills', 'Telephone bills'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_WATER',                      'expenses', 'utilities',                'business_expense', 'Water bills', 'Water bills'),
  M('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_OTHER_UTILITIES',            'expenses', 'utilities',                'business_expense', 'Other miscellaneous utility bills', 'Other miscellaneous utility bills'),

  // ─── OTHER ────────────────────────────────────────────────────────
  M('OTHER', 'OTHER_OTHER', 'other_expense', 'uncategorized_expense', 'uncategorized', 'Miscellaneous, no specific PFC.', null),
];

// Module-load invariant: every entry must reference a canonical
// (account_type, detail_type) pair. Catches typos at boot.
for (const m of PFC_COA_MAPPINGS) {
  const at = getAccountType(m.accountType);
  if (!at) throw new Error(`PFC_COA_MAPPINGS: unknown accountType "${m.accountType}" for ${m.pfcDetailed}`);
  // gaapType is implied by accountType — the resolver will read it from the org's CoA row.
  const triple = validateCoaTriple({ gaapType: at.gaapType, accountType: m.accountType, detailType: m.detailType });
  if (triple) throw new Error(`PFC_COA_MAPPINGS: bad mapping for ${m.pfcDetailed}: ${triple}`);
}

const BY_DETAILED = new Map<string, PfcMapping>(PFC_COA_MAPPINGS.map((m) => [m.pfcDetailed, m]));

export function getPfcMapping(pfcDetailed: string): PfcMapping | null {
  return BY_DETAILED.get(pfcDetailed) ?? null;
}

const BY_CLASSIFICATION = (() => {
  const map = new Map<PfcClassification, string[]>();
  for (const m of PFC_COA_MAPPINGS) {
    const list = map.get(m.classification) ?? [];
    list.push(m.pfcDetailed);
    map.set(m.classification, list);
  }
  return map;
})();

/**
 * The list of PFCv2 detailed codes that map to a given classification. Used
 * server-side to build SQL filters for the to_review queue (e.g. "show me
 * only the rows where pfc_detailed is one of the asset_movement codes").
 */
export function pfcDetailedByClassification(c: PfcClassification): string[] {
  return BY_CLASSIFICATION.get(c) ?? [];
}

/** Human label for the (account_type, detail_type) pair, used in UI/logs. */
export function pfcMappingLabel(m: PfcMapping): string {
  const at = getAccountType(m.accountType);
  const d = getDetail(m.accountType, m.detailType);
  return `${at?.label ?? m.accountType} / ${d?.label ?? m.detailType}`;
}

/**
 * Should the client need to review this category before it counts as final?
 *
 * The split: confidently-classified rows (business_expense / business_income /
 * personal / liability_*) are trustworthy enough to auto-mark reviewed=true.
 * Anything that's a transfer (asset_movement, transfer_review) or genuinely
 * uncategorized must come through the review queue first.
 */
export function reviewedByDefault(classification: PfcClassification): boolean {
  switch (classification) {
    case 'business_expense':
    case 'business_income':
    case 'personal':
    case 'liability_paydown':
    case 'liability_increase':
      return true;
    case 'asset_movement':
    case 'transfer_review':
    case 'uncategorized':
      return false;
  }
}

export interface PfcQuestionTemplate {
  /** The clarifying question to surface to the client. */
  question: string;
  /** Plaid's description for context (descriptionV2). Useful as a tooltip. */
  description: string;
  /** Optional concrete examples drawn from descriptionV1, when meaningfully
   *  different from descriptionV2. */
  examples: string | null;
}

/**
 * Template a clarifying question per PFC. Used by the to_review queue UI
 * (shown inline on each row) and downstream by any code that wants to ask
 * the client about a specific transaction (AI assistant prompts, digest
 * emails, etc.). The question is shaped by classification — so every
 * transfer_review row gets the same flavor of question, every personal row
 * gets the same flavor, etc. Plaid's description provides the specific
 * context for why this PFC fired.
 */
export function pfcQuestion(mapping: PfcMapping): PfcQuestionTemplate {
  let question: string;
  switch (mapping.classification) {
    case 'transfer_review':
      question = 'Was this a customer payment or a personal transfer?';
      break;
    case 'asset_movement':
      question = 'Internal transfer between your own accounts — pick the other side, or recategorize.';
      break;
    case 'personal':
      question = 'Personal expense (owner draw). Confirm or move to a business account?';
      break;
    case 'uncategorized':
      question = "Plaid couldn't classify this. What is it?";
      break;
    case 'business_expense':
      question = 'Business expense — pick the right category.';
      break;
    case 'business_income':
      question = 'Business income — confirm the revenue category.';
      break;
    case 'liability_paydown':
      question = 'Pick the loan or credit card being paid down.';
      break;
    case 'liability_increase':
      question = 'Confirm this loan disbursement and pick the liability account.';
      break;
  }
  const examples =
    mapping.descriptionV1 && mapping.descriptionV1 !== mapping.descriptionV2
      ? mapping.descriptionV1
      : null;
  return { question, description: mapping.descriptionV2, examples };
}
