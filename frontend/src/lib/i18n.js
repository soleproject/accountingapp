// Feather-light i18n. Zero runtime deps — a static string table keyed
// by region. Every call falls back to the US string, so a UK company
// with an incomplete UK map still renders (in US English) instead of
// showing a raw key.
//
// Phase 0 (Feb 2026): UK map intentionally empty. Every t() call
// returns the US string until Phase 1 populates the UK entries.
// This is deliberate — it lets us wire the *plumbing* through the
// whole app now without risking a single visible change for US users.

const STRINGS = {
  US: {
    // Report titles
    balance_sheet: "Balance Sheet",
    profit_and_loss: "Profit & Loss",
    income_statement: "Income Statement",
    trial_balance: "Trial Balance",
    // Ledger nouns
    accounts_receivable: "Accounts Receivable",
    accounts_payable: "Accounts Payable",
    inventory: "Inventory",
    revenue: "Revenue",
    fiscal_year: "Fiscal Year",
    // Tax nouns
    sales_tax: "Sales Tax",
  },
  UK: {
    // Phase 1 populates. Deliberately empty in Phase 0 so every
    // string resolves to the US default via the fallback below.
  },
};

/**
 * Return a localized string for the given key + region. If the region
 * has no override for the key, falls back to the US string. If even
 * US doesn't have the key (developer typo), returns the key itself so
 * bugs are visible rather than silently blank.
 */
export const t = (key, region = "US") => {
  const table = STRINGS[String(region || "US").toUpperCase()] || STRINGS.US;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  if (Object.prototype.hasOwnProperty.call(STRINGS.US, key)) return STRINGS.US[key];
  return key;
};

// Test hook — never called in production code.
export const _STRINGS_FOR_TEST = STRINGS;
