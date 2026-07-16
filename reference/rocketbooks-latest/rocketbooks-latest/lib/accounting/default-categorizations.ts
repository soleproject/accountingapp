import 'server-only';

/**
 * Deterministic categorization rules. The categorization workspace runs
 * these against each contact at session-start to pre-fill recommendations.
 * Rules that match an existing account in the org's CoA recommend that
 * account; rules with no fitting existing account propose creating a new one.
 *
 * Match strategy: case-insensitive regex against the contact name. Rules are
 * ordered — first match wins, so put more-specific rules first (e.g. "wells
 * fargo home mortgage" before generic "wells fargo").
 */

export interface CategoryRule {
  /** Tested against contact name (case-insensitive). */
  match: RegExp;
  /** Canonical gaapType for the recommended account. */
  gaapType: string;
  /** Used for new-account proposal AND to find a fitting existing account. */
  suggestedAccountName: string;
  /** Two-digit prefix; rules engine finds smallest unused 4-digit number with this prefix. */
  suggestedNumberPrefix: string;
  /** Stored in chart_of_accounts.definition when a new account is created. */
  description: string;
  /**
   * Optional fine-grain matcher to identify the "right" existing account
   * within the gaapType. Default: case-insensitive name contains
   * `suggestedAccountName`.
   */
  matchExisting?: (account: { accountName: string; gaapType: string }) => boolean;
}

interface ExistingAccountCandidate {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

export type RuleRecommendation =
  | {
      kind: 'existing-account';
      ruleLabel: string;
      account: { id: string; accountNumber: string; accountName: string };
    }
  | {
      kind: 'create-new-account';
      ruleLabel: string;
      proposed: {
        accountName: string;
        accountNumber: string;
        gaapType: string;
        description: string;
      };
    };

const defaultMatchExisting =
  (suggestedAccountName: string, gaapType: string) =>
  (a: { accountName: string; gaapType: string }): boolean =>
    a.gaapType === gaapType &&
    a.accountName.toLowerCase().includes(suggestedAccountName.toLowerCase());

export const DEFAULT_RULES: CategoryRule[] = [
  // ── Credit cards (current_liability, 21xx) ────────────────────────────
  {
    match: /\b(capital one|chase card|amex|american express|citi card|citi(bank)? credit|visa\b|discover\b)\b/i,
    gaapType: 'current_liability',
    suggestedAccountName: 'Credit Card',
    suggestedNumberPrefix: '21',
    description: 'Credit card liability — outstanding statement balance.',
    matchExisting: (a) =>
      a.gaapType === 'current_liability' && /credit card|cc\b/i.test(a.accountName),
  },

  // ── Mortgages (long_term_liability, 25xx) ─────────────────────────────
  {
    match: /\b(rocket mortgage|wells fargo home|chase home|mortgage|home loan)\b/i,
    gaapType: 'long_term_liability',
    suggestedAccountName: 'Mortgage Liability',
    suggestedNumberPrefix: '25',
    description: 'Long-term mortgage liability — principal balance.',
    matchExisting: (a) =>
      (a.gaapType === 'long_term_liability' || a.gaapType === 'liability') &&
      /mortgage|home loan/i.test(a.accountName),
  },

  // ── Bank transfers (current_liability, 21xx — internal-transfer clearing) ─
  {
    match: /\b(online banking transfer|internal transfer|wire transfer|ach transfer|fedwire)\b/i,
    gaapType: 'current_liability',
    suggestedAccountName: 'Internal Transfers',
    suggestedNumberPrefix: '21',
    description: 'Clearing account for internal transfers between bank accounts.',
    matchExisting: (a) =>
      a.gaapType === 'current_liability' && /transfer/i.test(a.accountName),
  },

  // ── Insurance (expense, 60xx range — assume in 6xxx block) ────────────
  {
    match: /\b(geico|state farm|progressive|allstate|metlife|new york life|ny life|nationwide insurance|liberty mutual|farmers insurance)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Insurance',
    suggestedNumberPrefix: '60',
    description: 'Insurance premiums — business and related.',
  },

  // ── Utilities — electric/gas/water (expense, 61xx) ────────────────────
  {
    match: /\b(nv energy|pg&?e|nv electric|truckee meadows|water authority|sierra pacific|so cal edison|socal gas|dominion energy|duke energy)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Utilities',
    suggestedNumberPrefix: '61',
    description: 'Electricity, gas, water, and similar utilities.',
    matchExisting: (a) => a.gaapType === 'expense' && /utilities|utility/i.test(a.accountName),
  },

  // ── Telephone & Internet (expense, 61xx) ──────────────────────────────
  {
    match: /\b(at&?t|verizon|t-mobile|tmobile|comcast|xfinity|spectrum|cox communications|frontier|sprint|google fiber)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Telephone & Internet',
    suggestedNumberPrefix: '61',
    description: 'Mobile, landline, and internet services.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /telephone|internet|phone|mobile/i.test(a.accountName),
  },

  // ── Software & subscriptions (expense, 60xx) ──────────────────────────
  {
    match: /\b(adobe|microsoft|google\s*workspace|gsuite|zoom|slack|notion|linear|github|vercel|aws|amazon web services|digitalocean|cloudflare|stripe(?! processing)|asana|figma)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Software & Subscriptions',
    suggestedNumberPrefix: '60',
    description: 'Software-as-a-service subscriptions and licenses.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /software|subscription|saas/i.test(a.accountName),
  },

  // ── Bank fees (expense, 60xx) ─────────────────────────────────────────
  {
    match: /\b(bank\s*fee|service\s*fee|nsf\s*fee|overdraft|wire\s*fee|atm\s*fee|maintenance\s*fee|monthly\s*fee)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Bank Fees',
    suggestedNumberPrefix: '60',
    description: 'Bank service charges, wire fees, NSF, and account maintenance.',
    matchExisting: (a) => a.gaapType === 'expense' && /bank\s*fee/i.test(a.accountName),
  },

  // ── Meals & Entertainment (expense, 60xx) ─────────────────────────────
  {
    match: /\b(starbucks|mcdonald'?s|burger king|chipotle|panera|subway|chick-?fil-?a|wendy'?s|taco bell|pizza hut|dominos|olive garden|in-?n-?out|five guys|jack in the box|panda express|dunkin|peet'?s|tim hortons|jimmy john'?s)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Meals & Entertainment',
    suggestedNumberPrefix: '60',
    description: 'Business meals, client entertainment, team lunches.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /meals|entertainment|m&e/i.test(a.accountName),
  },

  // ── Office Supplies (expense, 60xx) ───────────────────────────────────
  {
    match: /\b(staples|office depot|officemax|costco(?:\s+wholesale)?|sam'?s club|amazon(?!\s*web)|target|walmart|best buy)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Office Supplies',
    suggestedNumberPrefix: '60',
    description: 'General office supplies and consumables.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /office\s*supplies|supplies/i.test(a.accountName),
  },

  // ── Travel — airlines, hotels, ride-share (expense, 60xx) ─────────────
  {
    match: /\b(uber|lyft|delta|united airlines|southwest|american airlines|jetblue|alaska airlines|marriott|hilton|hyatt|airbnb|hertz|enterprise rent|avis|budget rent)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Travel',
    suggestedNumberPrefix: '60',
    description: 'Airfare, hotels, ground transport, and lodging.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /travel|lodging/i.test(a.accountName),
  },

  // ── Auto & Vehicle (expense, 61xx) ────────────────────────────────────
  {
    match: /\b(shell|chevron|exxon|mobil|76 station|valero|arco|sunoco|bp\s*gas|texaco|gas\s*station|jiffy lube|firestone)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Auto & Vehicle',
    suggestedNumberPrefix: '61',
    description: 'Vehicle fuel, maintenance, parking, and registration.',
    matchExisting: (a) => a.gaapType === 'expense' && /auto|vehicle|gas|fuel/i.test(a.accountName),
  },

  // ── Repairs & Maintenance (expense, 61xx) ─────────────────────────────
  {
    match: /\b(home depot|lowe'?s|ace hardware|menards|true value|repair|maintenance services)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Repairs & Maintenance',
    suggestedNumberPrefix: '61',
    description: 'Building, equipment, and asset repairs and maintenance.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /repair|maintenance/i.test(a.accountName),
  },

  // ── Wages & Payroll (expense, 61xx) ───────────────────────────────────
  {
    match: /\b(adp\s|gusto|paychex|rippling|justworks|trinet|onpay|sure\s*payroll|paylocity)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Wages & Payroll',
    suggestedNumberPrefix: '61',
    description: 'Employee wages, salaries, and payroll service fees.',
    matchExisting: (a) =>
      a.gaapType === 'expense' && /wages|payroll|salary/i.test(a.accountName),
  },

  // ── Veterinary / Pet (expense, 62xx — empty range in "New, LLC" CoA) ──
  {
    match: /\b(vca animal|veterinary|vet hospital|petsmart|petco|chewy|healthy paws)\b/i,
    gaapType: 'expense',
    suggestedAccountName: 'Veterinary Expenses',
    suggestedNumberPrefix: '62',
    description: 'Veterinary services and pet medical care.',
  },
];

/**
 * Given a contact name and the org's existing accounts, find the first
 * matching rule and produce a recommendation. Returns null if no rule matches
 * (caller falls back to AI engine in PR2 — for PR1 those contacts stay
 * unrecommended and the user picks manually via Change button).
 */
export function recommendByRules(
  contactName: string,
  orgAccounts: ExistingAccountCandidate[],
): RuleRecommendation | null {
  if (!contactName) return null;
  const trimmed = contactName.trim();
  if (trimmed.length === 0) return null;

  for (const rule of DEFAULT_RULES) {
    if (!rule.match.test(trimmed)) continue;

    const matcher =
      rule.matchExisting ?? defaultMatchExisting(rule.suggestedAccountName, rule.gaapType);
    const fitting = orgAccounts.find(matcher);
    const ruleLabel = `${rule.gaapType} · ${rule.suggestedAccountName}`;

    if (fitting) {
      return {
        kind: 'existing-account',
        ruleLabel,
        account: {
          id: fitting.id,
          accountNumber: fitting.accountNumber,
          accountName: fitting.accountName,
        },
      };
    }

    // Pick smallest unused 4-digit number in the rule's prefix range.
    const proposedNumber = findNextAvailableNumber(rule.suggestedNumberPrefix, orgAccounts);
    return {
      kind: 'create-new-account',
      ruleLabel,
      proposed: {
        accountName: rule.suggestedAccountName,
        accountNumber: proposedNumber,
        gaapType: rule.gaapType,
        description: rule.description,
      },
    };
  }

  return null;
}

function findNextAvailableNumber(
  twoDigitPrefix: string,
  accounts: ExistingAccountCandidate[],
): string {
  const taken = new Set(accounts.map((a) => a.accountNumber).filter((n) => /^\d{4}$/.test(n)));
  // Start at <prefix>00, scan to <prefix>99
  const start = parseInt(twoDigitPrefix + '00', 10);
  const end = parseInt(twoDigitPrefix + '99', 10);
  for (let n = start; n <= end; n++) {
    const candidate = String(n).padStart(4, '0');
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback: append 9999 if the entire range is full (vanishingly unlikely)
  return twoDigitPrefix + '99';
}
