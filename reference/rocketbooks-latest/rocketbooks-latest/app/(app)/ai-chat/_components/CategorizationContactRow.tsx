'use client';

import { useState } from 'react';
import type { SessionContactView } from '@/lib/server/categorization-session';

function fmtDollars(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

interface AccountOption {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

interface Props {
  contact: SessionContactView;
  accountOptions: AccountOption[];
  busy: boolean;
  onApply: (accountIdCandidate: string, source: 'rules' | 'manual') => void;
  onSkip: () => void;
  onUnskip: () => void;
}

const STATUS_DOT = {
  pending: 'bg-amber-500',
  done: 'bg-emerald-500',
  skipped: 'bg-zinc-400',
  failed: 'bg-red-500',
} as const;

const STATUS_LABEL = {
  pending: 'Pending',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
} as const;

export function CategorizationContactRow({
  contact,
  accountOptions,
  busy,
  onApply,
  onSkip,
  onUnskip,
}: Props) {
  const [changing, setChanging] = useState(false);
  const [changeChoice, setChangeChoice] = useState<string>('');

  const isPending = contact.status === 'pending' || contact.status === 'failed';
  const isDone = contact.status === 'done';
  const isSkipped = contact.status === 'skipped';

  const sourceIcon = (() => {
    if (contact.recommendedSource === 'rules') return '📐';
    if (contact.recommendedSource === 'ai') return '🤖';
    if (contact.recommendedSource === 'manual') return '✋';
    return null;
  })();

  // Direction tint applies only while the row is still pending. Withdrawal
  // → red, deposit → green. Done rows use the emerald done-state styling;
  // skipped rows use the muted skipped style; both override the tint.
  const directionTint = !isPending
    ? ''
    : contact.direction === 'deposit'
      ? 'bg-green-50 dark:bg-green-950/30'
      : 'bg-red-50 dark:bg-red-950/30';

  return (
    <div
      className={`flex flex-wrap items-center gap-3 border-b border-zinc-100 px-3 py-2 text-sm dark:border-zinc-800 ${
        isDone ? 'bg-emerald-50/40 text-zinc-500 dark:bg-emerald-950/10' : directionTint
      } ${isSkipped ? 'italic text-zinc-500' : ''}`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[contact.status]}`} aria-label={STATUS_LABEL[contact.status]} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
          {contact.contactName ?? <em className="text-zinc-500">No contact assigned</em>}
        </div>
        <div className="text-xs text-zinc-500">
          {contact.transactionCount} txn{contact.transactionCount === 1 ? '' : 's'} · {fmtDollars(contact.totalAmount)}
          {contact.oldestDate && contact.newestDate && (
            <>
              {' · '}
              {contact.oldestDate}
              {contact.oldestDate !== contact.newestDate ? ` – ${contact.newestDate}` : ''}
            </>
          )}
        </div>
      </div>

      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {isDone && contact.appliedAccountName && (
          <span className="rounded-md bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
            ✓ {contact.appliedAccountName}
          </span>
        )}
        {isSkipped && (
          <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            Skipped
          </span>
        )}
        {isPending && contact.recommendationLabel && (
          <span className="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            {sourceIcon && <span className="mr-1">{sourceIcon}</span>}
            {contact.recommendationLabel}
          </span>
        )}
        {isPending && !contact.recommendationLabel && (
          <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs italic text-zinc-500 dark:bg-zinc-800">
            No recommendation — use chat or pick manually
          </span>
        )}
      </div>

      {isPending && !changing && (
        <div className="flex items-center gap-1">
          {contact.recommendedAccountId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onApply(contact.recommendedAccountId!, 'rules')}
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Approve
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setChanging(true)}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Change
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSkip}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Skip
          </button>
        </div>
      )}

      {isPending && changing && (
        <div className="flex w-full items-center gap-1 sm:w-auto">
          <select
            value={changeChoice}
            onChange={(e) => setChangeChoice(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Pick account…</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName} ({a.gaapType})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !changeChoice}
            onClick={() => {
              onApply(changeChoice, 'manual');
              setChanging(false);
              setChangeChoice('');
            }}
            className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setChanging(false);
              setChangeChoice('');
            }}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      )}

      {isSkipped && (
        <button
          type="button"
          disabled={busy}
          onClick={onUnskip}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Undo skip
        </button>
      )}
    </div>
  );
}
