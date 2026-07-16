import 'server-only';

/**
 * QBO's AccountType → rocketsuite chart_of_accounts taxonomy mapping.
 *
 * QBO exposes 15 top-level AccountType values (`Bank`, `Accounts Receivable`,
 * `Other Current Asset`, `Fixed Asset`, `Other Asset`, `Accounts Payable`,
 * `Credit Card`, `Long Term Liability`, `Other Current Liability`, `Equity`,
 * `Income`, `Cost of Goods Sold`, `Expense`, `Other Income`, `Other Expense`)
 * and a freer-form `AccountSubType` underneath. We map AccountType to our
 * required gaap_type + normal_balance + a coarse account_type string, and
 * pass AccountSubType through normalizeDetailType into detail_type so QB's
 * PascalCase ("EntertainmentMeals") matches seed/PFC snake_case
 * ("entertainment_meals") and the (gaap_type, detail_type) UNIQUE constraint
 * collapses duplicates instead of forcing two rows for the same concept.
 * Any QBO type we don't recognize falls back to the 'other' category so the
 * promote never fails mid-migration on a new Intuit-side enum value.
 *
 * gaapType uses 'income' (not 'revenue') to match GAAP_TYPES in
 * coa-taxonomy.ts — seed rows, PFC mappings, and the canonical taxonomy all
 * agree on 'income'. Earlier 'revenue' was a drift bug that made every
 * QBO-imported income account land in a slot no seed row occupied.
 */
export interface LocalAccountTaxonomy {
  gaapType: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  accountType: string;
  normalBalance: 'debit' | 'credit';
}

const MAP: Record<string, LocalAccountTaxonomy> = {
  'Bank':                       { gaapType: 'asset',     accountType: 'bank',                   normalBalance: 'debit'  },
  'Accounts Receivable':        { gaapType: 'asset',     accountType: 'accounts_receivable',    normalBalance: 'debit'  },
  'Other Current Asset':        { gaapType: 'asset',     accountType: 'other_current_assets',   normalBalance: 'debit'  },
  'Fixed Asset':                { gaapType: 'asset',     accountType: 'fixed_assets',           normalBalance: 'debit'  },
  'Other Asset':                { gaapType: 'asset',     accountType: 'other_asset',            normalBalance: 'debit'  },
  'Accounts Payable':           { gaapType: 'liability', accountType: 'accounts_payable',       normalBalance: 'credit' },
  'Credit Card':                { gaapType: 'liability', accountType: 'credit_card',            normalBalance: 'credit' },
  'Long Term Liability':        { gaapType: 'liability', accountType: 'long_term_liabilities',  normalBalance: 'credit' },
  'Other Current Liability':    { gaapType: 'liability', accountType: 'other_current_liabilities', normalBalance: 'credit' },
  'Equity':                     { gaapType: 'equity',    accountType: 'equity',                 normalBalance: 'credit' },
  'Income':                     { gaapType: 'income',    accountType: 'income',                 normalBalance: 'credit' },
  'Other Income':               { gaapType: 'income',    accountType: 'other_income',           normalBalance: 'credit' },
  'Cost of Goods Sold':         { gaapType: 'expense',   accountType: 'cost_of_goods_sold',     normalBalance: 'debit'  },
  'Expense':                    { gaapType: 'expense',   accountType: 'expenses',               normalBalance: 'debit'  },
  'Other Expense':              { gaapType: 'expense',   accountType: 'other_expense',          normalBalance: 'debit'  },
};

const FALLBACK: LocalAccountTaxonomy = {
  gaapType: 'asset',
  accountType: 'other',
  normalBalance: 'debit',
};

export function mapQboAccountType(qboAccountType: string): LocalAccountTaxonomy {
  return MAP[qboAccountType] ?? FALLBACK;
}

/**
 * Convert QBO's PascalCase AccountSubType ("EntertainmentMeals",
 * "RentOrLeaseOfBuildings") to the snake_case slug convention used by
 * default-coa-data.ts seeds and pfc-coa-mapping.ts. Without this, the
 * promoter's slot-match never finds an existing seed row to merge into and
 * every QBO account lands as a parallel duplicate row.
 *
 * Rules:
 *   - Insert underscore before each uppercase letter that follows a
 *     lowercase letter or digit ("RentOr" → "Rent_Or")
 *   - Insert underscore between consecutive uppercases when the next
 *     uppercase is followed by a lowercase ("ARBalance" → "AR_Balance")
 *   - Lowercase the result
 *   - Collapse any runs of underscores from input punctuation/spaces
 *
 * Inputs that already look snake_case pass through unchanged so the
 * function is safe to call on already-normalized values (idempotent).
 *
 * Caveats this function does NOT handle (use AI fallback or manual mapping
 * if needed):
 *   - Word-order differences: "MealsEntertainment" → "meals_entertainment"
 *     does not match seed's "entertainment_meals"
 *   - Synonyms/abbreviations: "OfficeGeneralAdministrativeExpenses" →
 *     "office_general_administrative_expenses" does not match seed's
 *     "office_general_admin"
 */
export function normalizeDetailType(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s\-./]+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

// Inverse of MAP — built once at module load so outbound serializers can
// resolve local accountType → QBO AccountType cheaply. When accountType is
// null (some seeded org-default rows don't set it) the gaapType-only
// fallback below kicks in.
const INVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(MAP).map(([qboType, local]) => [local.accountType, qboType]),
);

const GAAP_FALLBACK_QBO_TYPE: Record<LocalAccountTaxonomy['gaapType'], string> = {
  asset:     'Other Current Asset',
  liability: 'Other Current Liability',
  equity:    'Equity',
  income:    'Income',
  expense:   'Expense',
};

/**
 * Local → QBO AccountType. Prefers the precise mapping when accountType is
 * set; falls back to a sensible default per gaapType when only gaapType is
 * known. Never throws — defaults all the way through.
 */
export function localAccountTypeToQbo(local: { gaapType: string; accountType: string | null }): string {
  if (local.accountType && INVERSE_MAP[local.accountType]) {
    return INVERSE_MAP[local.accountType];
  }
  return GAAP_FALLBACK_QBO_TYPE[local.gaapType as LocalAccountTaxonomy['gaapType']] ?? 'Other Current Asset';
}
