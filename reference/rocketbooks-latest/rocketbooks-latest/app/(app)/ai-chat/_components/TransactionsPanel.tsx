'use client';

import Link from 'next/link';

export interface TransactionsResult {
  filters: {
    from?: string;
    to?: string;
    contactId?: string;
    contactName?: string;
    type?: 'deposit' | 'withdrawal';
    minAmount?: number;
    maxAmount?: number;
    accountName?: string;
    onlyUnreviewed?: boolean;
    searchText?: string;
    limit?: number;
    sort?: string;
  };
  count: number;
  totalAmount: number;
  truncated: boolean;
  note?: string;
  rows: Array<{
    id: string;
    date: string;
    description: string;
    type: string | null;
    amount: number;
    reviewed: boolean;
    contactName: string | null;
    accountLabel: string | null;
  }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatDateRange(from?: string, to?: string): string | null {
  if (!from && !to) return null;
  if (from && to) return `${from} → ${to}`;
  if (from) return `from ${from}`;
  return `through ${to}`;
}

function buildFilterDescriptors(filters: TransactionsResult['filters']): string[] {
  const out: string[] = [];
  if (filters.contactName) out.push(`Contact: ${filters.contactName}`);
  if (filters.type === 'deposit') out.push('Deposits');
  if (filters.type === 'withdrawal') out.push('Withdrawals');
  if (filters.accountName) out.push(`Account: ${filters.accountName}`);
  if (typeof filters.minAmount === 'number') out.push(`≥ ${fmt(filters.minAmount)}`);
  if (typeof filters.maxAmount === 'number') out.push(`≤ ${fmt(filters.maxAmount)}`);
  if (filters.onlyUnreviewed) out.push('Needs review');
  if (filters.searchText) out.push(`"${filters.searchText}"`);
  return out;
}

export function TransactionsPanel({ result, onClose }: { result: TransactionsResult; onClose?: () => void }) {
  const dateRange = formatDateRange(result.filters.from, result.filters.to);
  const descriptors = buildFilterDescriptors(result.filters);

  return (
    <div className="relative overflow-hidden rounded-lg border border-blue-300 bg-white shadow-sm transition-all dark:border-blue-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-blue-200 bg-blue-50 px-5 py-3 dark:border-blue-900 dark:bg-blue-950/30">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            ◇ Transactions
          </div>
          <div className="text-lg font-semibold">
            {dateRange ?? 'All transactions'}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right text-sm">
            <div className="text-zinc-500">{result.count === 1 ? 'Match' : 'Matches'}</div>
            <div className="text-lg font-semibold tabular-nums">
              {result.count}
              <span className="ml-2 text-sm font-normal text-zinc-500">{fmt(result.totalAmount)}</span>
            </div>
          </div>
          {onClose && <PanelCloseButton onClose={onClose} />}
        </div>
      </div>

      {(descriptors.length > 0 || result.note) && (
        <div className="grid grid-cols-2 gap-4 border-b border-zinc-100 px-5 py-3 text-sm dark:border-zinc-800">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Filters</div>
            {descriptors.length > 0 ? (
              <div className="font-medium">{descriptors.join(' · ')}</div>
            ) : (
              <div className="text-zinc-400"><em>none</em></div>
            )}
          </div>
          <div className="text-right">
            {result.note && (
              <>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Note</div>
                <div className="text-zinc-700 dark:text-zinc-300">{result.note}</div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
              <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
              <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
              <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-4 text-center text-zinc-500">
                  No transactions match these filters.
                </td>
              </tr>
            )}
            {result.rows.map((r) => {
              const isDeposit = r.type === 'deposit';
              return (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="whitespace-nowrap px-5 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                    {r.date}
                  </td>
                  <td className="px-5 py-2 text-zinc-700 dark:text-zinc-300">
                    <Link href={`/transactions/${r.id}`} className="hover:underline">
                      {r.description || <em className="text-zinc-400">—</em>}
                    </Link>
                    {!r.reviewed && (
                      <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                        review
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-xs text-zinc-500">
                    {r.contactName ?? <em className="text-zinc-400">—</em>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-xs text-zinc-500">
                    {r.accountLabel ?? <em className="text-zinc-400">uncategorized</em>}
                  </td>
                  <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums ${
                    isDeposit ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-700 dark:text-zinc-300'
                  }`}>
                    {isDeposit ? '+' : ''}{fmt(r.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
              <td colSpan={4} className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                Total
              </td>
              <td className="px-5 py-2 text-right text-base font-semibold tabular-nums">
                {fmt(result.totalAmount)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {result.truncated && (
        <div className="border-t border-blue-200 bg-blue-50 px-5 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center justify-between">
            <span className="text-blue-900 dark:text-blue-100">
              Showing first {result.rows.length} of {result.count}
            </span>
            <Link href="/transactions" className="text-xs underline">
              View all on /transactions
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PanelCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close panel"
      title="Close"
      className="-mt-1 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}
