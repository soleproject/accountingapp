'use client';

import Link from 'next/link';

export interface InvoiceDraftView {
  draftId: string;
  status: string;
  posted: boolean;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  memo: string | null;
  contact: { id: string; name: string };
  arAccount: { id: string; accountNumber: string; accountName: string } | null;
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    revenueAccountId: string;
    revenueAccountLabel: string;
  }>;
  total: number;
  journalEntryId: string | null;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function InvoicePreview({ draft, onClose }: { draft: InvoiceDraftView; onClose?: () => void }) {
  return (
    <div className={`relative overflow-hidden rounded-lg border bg-white shadow-sm transition-all dark:bg-zinc-950 ${
      draft.posted
        ? 'border-emerald-400 dark:border-emerald-700'
        : 'border-blue-300 dark:border-blue-800'
    }`}>
      <div className={`flex items-center justify-between border-b px-5 py-3 ${
        draft.posted
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
          : 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30'
      }`}>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            {draft.posted ? '✓ Posted invoice' : '◇ Draft invoice (live)'}
          </div>
          <div className="text-lg font-semibold">
            Invoice {draft.invoiceNumber ?? <span className="font-mono text-sm text-zinc-500">#{draft.draftId.slice(0, 8)}</span>}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right text-sm">
            <div className="text-zinc-500">Date</div>
            <div className="tabular-nums">{draft.invoiceDate}</div>
          </div>
          {onClose && <CloseButton onClose={onClose} />}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-zinc-100 px-5 py-3 text-sm dark:border-zinc-800">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Bill to</div>
          <div className="font-medium">{draft.contact.name || <em className="text-zinc-400">(no contact)</em>}</div>
        </div>
        <div className="text-right">
          {draft.dueDate && (
            <>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Due</div>
              <div className="tabular-nums">{draft.dueDate}</div>
            </>
          )}
          {draft.arAccount && (
            <div className="mt-1 text-xs text-zinc-500">
              AR: {draft.arAccount.accountNumber} · {draft.arAccount.accountName}
            </div>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
            <th className="px-5 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
            <th className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Qty</th>
            <th className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Price</th>
            <th className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
          </tr>
        </thead>
        <tbody>
          {draft.lines.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-4 text-center text-zinc-500">No lines yet — keep talking…</td>
            </tr>
          )}
          {draft.lines.map((l) => (
            <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-5 py-2 text-zinc-700 dark:text-zinc-300">{l.description}</td>
              <td className="px-5 py-2 text-xs text-zinc-500">{l.revenueAccountLabel}</td>
              <td className="px-5 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{l.quantity}</td>
              <td className="px-5 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmt(l.unitPrice)}</td>
              <td className="px-5 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmt(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={4} className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Total</td>
            <td className="px-5 py-2 text-right text-base font-semibold tabular-nums">{fmt(draft.total)}</td>
          </tr>
        </tfoot>
      </table>

      {draft.memo && (
        <div className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
          Memo: <span className="text-zinc-700 dark:text-zinc-300">{draft.memo}</span>
        </div>
      )}

      {draft.posted && (
        <div className="border-t border-emerald-200 bg-emerald-50 px-5 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex items-center justify-between">
            <span className="text-emerald-900 dark:text-emerald-100">✓ Posted to journal</span>
            <div className="flex gap-3 text-xs">
              <Link href={`/invoices/${draft.draftId}`} className="underline">View invoice</Link>
              {draft.journalEntryId && (
                <Link href={`/journal-entries/${draft.journalEntryId}`} className="underline">View JE</Link>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
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
