'use client';

import Link from 'next/link';

export interface BillsResult {
  filters: {
    status?: 'all' | 'overdue' | 'outstanding' | 'paid';
    vendorId?: string;
    vendorName?: string;
    from?: string;
    to?: string;
    limit?: number;
    sort?: string;
  };
  count: number;
  totalAmount: number;
  truncated?: boolean;
  note?: string;
  rows: Array<{
    id: string;
    billNumber: string;
    billDate: string;
    dueDate: string | null;
    status: string;
    vendor: string;
    amount: number;
    outstanding: number;
    isPaid: boolean;
    isOverdue: boolean;
    daysOverdue: number;
  }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function statusTone(row: BillsResult['rows'][number]): string {
  if (row.isPaid) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
  if (row.isOverdue) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300';
  return 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300';
}

function statusLabel(row: BillsResult['rows'][number]): string {
  if (row.isPaid) return 'paid';
  if (row.isOverdue) return `overdue ${row.daysOverdue}d`;
  return 'open';
}

function buildFilterDescriptors(f: BillsResult['filters']): string[] {
  const out: string[] = [];
  if (f.status && f.status !== 'all') out.push(f.status);
  if (f.vendorName) out.push(`Vendor: ${f.vendorName}`);
  if (f.from && f.to) out.push(`${f.from} → ${f.to}`);
  else if (f.from) out.push(`from ${f.from}`);
  else if (f.to) out.push(`through ${f.to}`);
  return out;
}

export function BillsPanel({ result, onClose }: { result: BillsResult; onClose?: () => void }) {
  const descriptors = buildFilterDescriptors(result.filters);

  return (
    <div className="relative overflow-hidden rounded-lg border border-amber-300 bg-white shadow-sm transition-all dark:border-amber-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-5 py-3 dark:border-amber-900 dark:bg-amber-950/30">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            ◇ Bills
          </div>
          <div className="text-lg font-semibold">
            {(result.filters.status && result.filters.status !== 'all')
              ? `${result.filters.status.charAt(0).toUpperCase()}${result.filters.status.slice(1)} bills`
              : 'All bills'}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Matches</div>
            <div className="text-lg font-semibold tabular-nums">{result.count}</div>
            <div className="text-xs tabular-nums text-zinc-500">{fmt(result.totalAmount)}</div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-zinc-500 hover:bg-amber-100 hover:text-zinc-900 dark:hover:bg-amber-900/40 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {descriptors.length > 0 && (
        <div className="border-b border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          <span className="mr-2 font-medium uppercase">Filters</span>
          {descriptors.join(' · ')}
        </div>
      )}

      {result.note && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {result.note}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Number</th>
              <th className="px-4 py-2 font-medium">Vendor</th>
              <th className="px-4 py-2 font-medium">Due</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                  No bills match these filters.
                </td>
              </tr>
            ) : (
              result.rows.map((r) => (
                <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.billDate}</td>
                  <td className="px-4 py-2 font-medium">
                    <Link href={`/bills/${r.id}`} className="text-amber-700 hover:underline dark:text-amber-300">
                      {r.billNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.vendor}</td>
                  <td className="px-4 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">{r.dueDate ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(r)}`}>
                      {statusLabel(r)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(r.outstanding)}</td>
                </tr>
              ))
            )}
          </tbody>
          {result.rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-zinc-100 dark:border-zinc-800">
                <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium uppercase text-zinc-500">Total</td>
                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{fmt(result.totalAmount)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {result.truncated && (
        <div className="border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          Results truncated — narrow the filters or open <Link href="/bills" className="text-amber-700 hover:underline dark:text-amber-300">/bills</Link>.
        </div>
      )}
    </div>
  );
}
