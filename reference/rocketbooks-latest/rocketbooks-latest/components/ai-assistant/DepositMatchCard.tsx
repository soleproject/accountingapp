'use client';

import Link from 'next/link';

export type DepositMatchView =
  | {
      kind: 'transfer';
      transactionId: string;
      amount: number;
      date: string;
      sourceAccount: string | null;
    }
  | {
      kind: 'invoice';
      invoiceId: string;
      invoiceNumber: string | null;
      balance: number;
      dueDate: string | null;
      customerName: string | null;
    };

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
}

/**
 * Compact card surfacing a find_transfer_counterpart / find_matching_invoice
 * match below the assistant message during deposit review — the visual aid for
 * the Transfer and Income flows.
 */
export function DepositMatchCard({ match }: { match: DepositMatchView }) {
  if (match.kind === 'transfer') {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
        <div className="font-semibold text-amber-900 dark:text-amber-200">Internal transfer — match found</div>
        <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
          Matches a <strong>{fmt(match.amount)}</strong> withdrawal from{' '}
          <strong>{match.sourceAccount ?? 'another account'}</strong> on {String(match.date).slice(0, 10)}. This is a
          transfer, not income.
        </p>
        <Link
          href={`/transactions/${match.transactionId}`}
          className="mt-1.5 inline-block text-xs font-medium text-amber-700 underline hover:text-amber-900 dark:text-amber-300"
        >
          View the matching transaction →
        </Link>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/40">
      <div className="font-semibold text-blue-900 dark:text-blue-200">Open invoice — match found</div>
      <p className="mt-0.5 text-xs text-blue-800 dark:text-blue-300">
        Matches {match.invoiceNumber ? <strong>Invoice {match.invoiceNumber}</strong> : 'an open invoice'}
        {match.customerName ? ` for ${match.customerName}` : ''} — balance <strong>{fmt(match.balance)}</strong>
        {match.dueDate ? `, due ${String(match.dueDate).slice(0, 10)}` : ''}. Booking this as a payment reduces A/R,
        not income.
      </p>
      <Link
        href={`/invoices/${match.invoiceId}`}
        className="mt-1.5 inline-block text-xs font-medium text-blue-700 underline hover:text-blue-900 dark:text-blue-300"
      >
        View the invoice →
      </Link>
    </div>
  );
}
