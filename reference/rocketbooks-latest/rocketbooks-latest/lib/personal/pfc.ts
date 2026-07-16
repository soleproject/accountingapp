/**
 * Plaid Personal Finance Category (PFC) → personal category mapping.
 *
 * Pure logic (no DB / no server-only) so it can be shared by the server promote
 * path, seeding, and one-off backfills. We use the DETAILED PFC tier for fine
 * categories (Groceries, Coffee, Gas, Streaming…), deriving a friendly name by
 * stripping the primary prefix off the detailed code. The catch-all OTHER_*
 * detailed buckets collapse back to the primary-level name.
 */

/** Primary PFC bucket -> the display group we file its categories under. */
export const PFC_PRIMARY_GROUP: Record<string, string> = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  LOAN_PAYMENTS: 'Bills & Utilities',
  BANK_FEES: 'Fees & Charges',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Health',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Services',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
};

/**
 * The full Plaid PFC detailed taxonomy, encoded as primary -> sub-labels (the
 * detailed code is `${primary}_${sub}`). Used to seed a complete default
 * category set so the picker/budgets are populated before every category has a
 * transaction.
 */
const PFC_TAXONOMY: Record<string, string[]> = {
  INCOME: ['DIVIDENDS', 'INTEREST_EARNED', 'RETIREMENT_PENSION', 'TAX_REFUND', 'UNEMPLOYMENT', 'WAGES', 'OTHER_INCOME'],
  TRANSFER_IN: ['CASH_ADVANCES_AND_LOANS', 'DEPOSIT', 'INVESTMENT_AND_RETIREMENT_FUNDS', 'SAVINGS', 'ACCOUNT_TRANSFER', 'OTHER_TRANSFER_IN'],
  TRANSFER_OUT: ['INVESTMENT_AND_RETIREMENT_FUNDS', 'SAVINGS', 'WITHDRAWAL', 'ACCOUNT_TRANSFER', 'OTHER_TRANSFER_OUT'],
  LOAN_PAYMENTS: ['CAR_PAYMENT', 'CREDIT_CARD_PAYMENT', 'PERSONAL_LOAN_PAYMENT', 'MORTGAGE_PAYMENT', 'STUDENT_LOAN_PAYMENT', 'OTHER_PAYMENT'],
  BANK_FEES: ['ATM_FEES', 'FOREIGN_TRANSACTION_FEES', 'INSUFFICIENT_FUNDS', 'INTEREST_CHARGE', 'OVERDRAFT_FEES', 'OTHER_BANK_FEES'],
  ENTERTAINMENT: ['CASINOS_AND_GAMBLING', 'MUSIC_AND_AUDIO', 'SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS', 'TV_AND_MOVIES', 'VIDEO_GAMES', 'OTHER_ENTERTAINMENT'],
  FOOD_AND_DRINK: ['BEER_WINE_AND_LIQUOR', 'COFFEE', 'FAST_FOOD', 'GROCERIES', 'RESTAURANT', 'VENDING_MACHINES', 'OTHER_FOOD_AND_DRINK'],
  GENERAL_MERCHANDISE: ['BOOKSTORES_AND_NEWSSTANDS', 'CLOTHING_AND_ACCESSORIES', 'CONVENIENCE_STORES', 'DEPARTMENT_STORES', 'DISCOUNT_STORES', 'ELECTRONICS', 'GIFTS_AND_NOVELTIES', 'OFFICE_SUPPLIES', 'ONLINE_MARKETPLACES', 'PET_SUPPLIES', 'SPORTING_GOODS', 'SUPERSTORES', 'TOBACCO_AND_VAPE', 'OTHER_GENERAL_MERCHANDISE'],
  HOME_IMPROVEMENT: ['FURNITURE', 'HARDWARE', 'REPAIR_AND_MAINTENANCE', 'SECURITY', 'OTHER_HOME_IMPROVEMENT'],
  MEDICAL: ['DENTAL_CARE', 'EYE_CARE', 'NURSING_CARE', 'PHARMACIES_AND_SUPPLEMENTS', 'PRIMARY_CARE', 'VETERINARY_SERVICES', 'OTHER_MEDICAL'],
  PERSONAL_CARE: ['GYMS_AND_FITNESS_CENTERS', 'HAIR_AND_BEAUTY', 'LAUNDRY_AND_DRY_CLEANING', 'OTHER_PERSONAL_CARE'],
  GENERAL_SERVICES: ['ACCOUNTING_AND_FINANCIAL_PLANNING', 'AUTOMOTIVE', 'CHILDCARE', 'CONSULTING_AND_LEGAL', 'EDUCATION', 'INSURANCE', 'POSTAGE_AND_SHIPPING', 'STORAGE', 'OTHER_GENERAL_SERVICES'],
  GOVERNMENT_AND_NON_PROFIT: ['DONATIONS', 'GOVERNMENT_DEPARTMENTS_AND_AGENCIES', 'TAX_PAYMENT', 'OTHER_GOVERNMENT_AND_NON_PROFIT'],
  TRANSPORTATION: ['BIKES_AND_SCOOTERS', 'GAS', 'PARKING', 'PUBLIC_TRANSIT', 'TAXIS_AND_RIDE_SHARES', 'TOLLS', 'OTHER_TRANSPORTATION'],
  TRAVEL: ['FLIGHTS', 'LODGING', 'RENTAL_CARS', 'OTHER_TRAVEL'],
  RENT_AND_UTILITIES: ['GAS_AND_ELECTRICITY', 'INTERNET_AND_CABLE', 'RENT', 'SEWAGE_AND_WASTE_MANAGEMENT', 'TELEPHONE', 'WATER', 'OTHER_UTILITIES'],
};

/** Acronyms that should stay upper-case after title-casing. */
const ACRONYMS: Record<string, string> = { Tv: 'TV', Atm: 'ATM' };

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => {
      const t = w.charAt(0).toUpperCase() + w.slice(1);
      return ACRONYMS[t] ?? t;
    })
    .join(' ');
}

export interface CategoryNameGroup {
  name: string;
  group: string;
}

/**
 * Map a Plaid PFC pair to a friendly { name, group }. Prefers the detailed
 * tier; collapses OTHER_* detailed buckets to the primary name; falls back to
 * the primary, then to Uncategorized.
 */
export function pfcToCategory(pfc: { primary?: string | null; detailed?: string | null } | null | undefined): CategoryNameGroup {
  const primary = pfc?.primary ?? null;
  const detailed = pfc?.detailed ?? null;
  if (!primary && !detailed) return { name: 'Uncategorized', group: 'Other' };

  const group = (primary && PFC_PRIMARY_GROUP[primary]) || 'Other';

  if (!detailed) {
    return { name: primary ? titleCase(primary) : 'Uncategorized', group };
  }

  let sub = detailed;
  if (primary && detailed.startsWith(primary + '_')) sub = detailed.slice(primary.length + 1);

  // Catch-all detailed buckets (e.g. FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK)
  // collapse to the primary-level name rather than an awkward "Other …".
  if (!sub || sub === 'OTHER' || sub.startsWith('OTHER_') || sub.startsWith('OTHER')) {
    return { name: primary ? titleCase(primary) : titleCase(detailed), group };
  }

  return { name: titleCase(sub), group };
}

/**
 * The full default category set, derived from the PFC taxonomy. Deduped by
 * name, preserving group/order. Plus the manual fallbacks.
 */
export function deriveDefaultCategories(): CategoryNameGroup[] {
  const out: CategoryNameGroup[] = [];
  const seen = new Set<string>();
  const push = (c: CategoryNameGroup) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c);
  };
  for (const [primary, subs] of Object.entries(PFC_TAXONOMY)) {
    for (const sub of subs) {
      push(pfcToCategory({ primary, detailed: `${primary}_${sub}` }));
    }
  }
  push({ name: 'Other', group: 'Other' });
  push({ name: 'Uncategorized', group: 'Other' });
  return out;
}
