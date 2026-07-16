interface GroupableAccount {
  id: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
}

const GAAP_GROUP_LABEL: Record<string, string> = {
  revenue: 'Income Accounts',
  income: 'Income Accounts',
  other_income: 'Income Accounts',
  cost_of_goods_sold: 'Cost of Goods Sold',
  cogs: 'Cost of Goods Sold',
  expense: 'Expense Accounts',
  other_expense: 'Expense Accounts',
  asset: 'Asset Accounts',
  liability: 'Liability Accounts',
  equity: 'Equity Accounts',
};

const GROUP_ORDER = [
  'Income Accounts',
  'Cost of Goods Sold',
  'Expense Accounts',
  'Asset Accounts',
  'Liability Accounts',
  'Equity Accounts',
];

export function groupAccountsByGaap<A extends GroupableAccount>(
  accounts: A[],
): Array<{ label: string; accounts: A[] }> {
  const bucket = new Map<string, A[]>();
  for (const a of accounts) {
    const key = GAAP_GROUP_LABEL[(a.gaapType ?? '').toLowerCase()] ?? 'Other';
    const arr = bucket.get(key);
    if (arr) arr.push(a);
    else bucket.set(key, [a]);
  }
  const ordered: Array<{ label: string; accounts: A[] }> = [];
  for (const label of GROUP_ORDER) {
    const accts = bucket.get(label);
    if (accts && accts.length) ordered.push({ label, accounts: accts });
    bucket.delete(label);
  }
  // Any leftover labels (e.g. "Other") get appended at the end alphabetically.
  for (const label of Array.from(bucket.keys()).sort()) {
    ordered.push({ label, accounts: bucket.get(label)! });
  }
  return ordered;
}
