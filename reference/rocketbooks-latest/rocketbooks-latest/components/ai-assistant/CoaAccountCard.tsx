'use client';

import Link from 'next/link';

export interface CoaAccountView {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
  accountType: string;
  detailType: string;
  normalBalance: 'debit' | 'credit';
  parentAccountId: string | null;
}

const GAAP_LABEL: Record<string, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

function humanize(slug: string): string {
  return slug
    .split('_')
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(' ');
}

export function CoaAccountCard({ account }: { account: CoaAccountView }) {
  return (
    <div className="overflow-hidden rounded-lg border border-emerald-400 bg-white shadow-sm dark:border-emerald-700 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50 px-5 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            ✓ Account created
          </div>
          <div className="text-lg font-semibold">
            {account.accountName}
            <span className="ml-2 font-mono text-sm text-zinc-500">#{account.accountNumber}</span>
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="text-xs uppercase tracking-wide text-zinc-500">GAAP</div>
          <div>{GAAP_LABEL[account.gaapType] ?? humanize(account.gaapType)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 px-5 py-3 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Account type</div>
          <div className="font-medium">{humanize(account.accountType)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Detail type</div>
          <div className="font-medium">{humanize(account.detailType)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Normal balance</div>
          <div className="font-medium capitalize">{account.normalBalance}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Sub-account of</div>
          <div className="font-medium">
            {account.parentAccountId ? (
              <span className="text-zinc-500">linked</span>
            ) : (
              <span className="text-zinc-400">—</span>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-emerald-200 bg-emerald-50 px-5 py-3 text-xs dark:border-emerald-900 dark:bg-emerald-950/30">
        <div className="flex items-center justify-between">
          <span className="text-emerald-900 dark:text-emerald-100">
            Added to your chart of accounts
          </span>
          <Link href="/chart-of-accounts" className="underline">
            View Chart of Accounts
          </Link>
        </div>
      </div>
    </div>
  );
}
