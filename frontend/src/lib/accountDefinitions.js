// GAAP-flavored one-line definitions for the default seeded chart of
// accounts. Surfaced in the mega-approve modal's info-icon tooltip so a
// reviewer can hover a category pill and confirm they're picking the
// right bucket without opening the Accounting help center.
//
// Keys are the seed code (as string). If a company creates a custom
// account we fall back to the "kind by code range" helper below.

export const ACCOUNT_DEFINITIONS = {
  // Assets
  "1000": "Cash & Bank — parent grouping for all operating cash balances (checking, savings, undeposited funds).",
  "1010": "Business Checking — primary operating checking account where day-to-day inflows/outflows land.",
  "1020": "Business Savings — reserve savings account earning interest, separate from operating checking.",
  "1100": "Undeposited Funds — customer payments received but not yet swept to the bank; clears on deposit.",
  "1200": "Accounts Receivable — money customers owe you for invoices billed but not yet paid.",
  "1300": "Inventory — goods held for sale, valued at cost until sold (moves to COGS on sale).",
  "1500": "Prepaid Expenses — payments made in advance for future services (insurance, rent) amortized over the period.",
  "1600": "Equipment — long-lived tangible assets (computers, machinery) capitalized and depreciated over useful life.",
  "1700": "Accumulated Depreciation — contra-asset that tracks total depreciation taken against fixed assets.",
  // Liabilities
  "2000": "Accounts Payable — bills you owe vendors for goods/services received but not yet paid.",
  "2100": "Credit Card Payable — outstanding balances on business credit cards; parent for per-card sub-accounts.",
  "2200": "Sales Tax Payable — sales tax collected from customers and owed to state/local jurisdictions.",
  "2500": "Loans Payable — principal owed on term loans, lines of credit, or SBA financing.",
  // Equity
  "3000": "Owner's Equity — cumulative owner stake: contributions + retained earnings − draws.",
  "3100": "Retained Earnings — accumulated prior-period net income not yet distributed to owners.",
  "3300": "Owner's Draw — cash pulled by the owner from the business for personal use (reduces equity).",
  "3400": "Owner's Contribution — personal funds the owner put into the business (increases equity).",
  // Revenue
  "4000": "Service Revenue — top-line income earned from selling services to customers.",
  "4100": "Product Sales — top-line income earned from selling physical goods.",
  "4200": "Interest Income — interest earned on bank balances, notes, or short-term investments.",
  // Expenses
  "6000": "Meals — deductible meals for business purposes (typically 50% deductible for tax).",
  "6010": "Entertainment — client/prospect entertainment; generally NOT tax-deductible post-TCJA.",
  "6100": "Travel — lodging, airfare, ground transport for business trips (100% deductible for tax).",
  "6120": "Transportation — local travel (rideshare, mileage, parking) directly tied to business activity.",
  "6200": "Advertising & Marketing — ads, promotions, sponsorships, marketing agency fees.",
  "6250": "Dues & Subscriptions — professional memberships, industry associations, recurring SaaS-adjacent dues.",
  "6300": "Office Supplies — consumables for the office (paper, toner, kitchen supplies, small hardware).",
  "6400": "Insurance — business insurance premiums: liability, property, E&O, workers' comp.",
  "6500": "Legal & Professional Fees — attorney, CPA, consultant, and other professional service fees.",
  "6600": "Utilities — electricity, gas, water, internet, phone service for business locations.",
  "6700": "Rent — office / warehouse / retail lease payments (operating lease expense).",
  "6800": "Supplies & Materials — production or job-site materials NOT held as inventory.",
  "6900": "Repairs & Maintenance — routine upkeep of equipment/property (major upgrades are capitalized instead).",
  "7000": "Bank Fees — monthly maintenance, wire, ACH, overdraft, and merchant processing fees.",
  "7100": "Software & SaaS — subscription software: accounting, CRM, productivity, cloud infra.",
  "7200": "Payroll — gross wages, employer payroll taxes, and payroll processor fees.",
  // Sinks (should never be picked in mega-approve, but define for completeness)
  "6999": "Uncategorized Expense — AI parking lot for expenses it couldn't confidently categorize. Should be cleared, not approved as-is.",
  "9999": "Uncategorized Expense — legacy sink from older seeds; same as 6999.",
  "4999": "Uncategorized Income — AI parking lot for income it couldn't confidently categorize (often owner contributions vs. loan proceeds vs. A/R payments).",
};

// Fallback definition based on the account's code prefix + subtype, used when
// a company has custom-created accounts that aren't in the seed dictionary.
export function accountDefinition(account) {
  if (!account) return "";
  const code = String(account.code || "");
  const explicit = ACCOUNT_DEFINITIONS[code];
  if (explicit) return explicit;
  const type = (account.type || "").toLowerCase();
  const sub = (account.subtype || "").toLowerCase();
  if (type === "asset" && sub.includes("current")) return "Current asset — cash or resource expected to convert to cash within 12 months.";
  if (type === "asset") return "Fixed asset — long-lived resource depreciated over its useful life.";
  if (type === "liability" && sub.includes("current")) return "Current liability — obligation due within 12 months.";
  if (type === "liability") return "Long-term liability — obligation due beyond 12 months.";
  if (type === "equity") return "Equity — owner claim on the business (contributions + retained earnings − draws).";
  if (type === "revenue") return "Revenue — top-line income earned from delivering goods or services.";
  if (type === "cogs") return "COGS — direct cost of goods sold; matched against revenue.";
  if (type === "expense") return "Operating expense — cost incurred to run the business, deducted from revenue on the P&L.";
  return "Custom account.";
}
