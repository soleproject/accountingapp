'use client';

import { useActionState, useState } from 'react';
import { mapPlaidAccountToCoa, promoteAccountAction, type MapState, type PromoteState } from '../_actions/mapAccount';

interface Account { id: string; accountNumber: string; accountName: string; }

interface Props {
  plaidAccountId: string;
  currentMappingId: string | null;
  inScope: boolean;
  candidates: Account[];
}

function fmt(n: number | null) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function AccountActions({ plaidAccountId, currentMappingId, inScope, candidates }: Props) {
  const [mapState, mapAction, mapping] = useActionState<MapState | undefined, FormData>(mapPlaidAccountToCoa, undefined);
  const [promoteState, promoteAction, promoting] = useActionState<PromoteState | undefined, FormData>(promoteAccountAction, undefined);
  const [selected, setSelected] = useState(currentMappingId ?? '');

  // The promote action doubles as "Add to books" (first time, flips in_scope)
  // and "Re-sync" (subsequent — backfills any raw rows not yet promoted).
  const promoteLabel = inScope ? 'Re-sync' : 'Add to books';
  const promoteTitle = !currentMappingId
    ? 'Map a COA bank account first'
    : inScope
      ? 'Backfill any unpromoted raw transactions'
      : 'Mark this account as part of the business and import its transactions';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={mapAction} className="flex items-center gap-2">
        <input type="hidden" name="plaidAccountId" value={plaidAccountId} />
        <select
          name="chartOfAccountId"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">— Map to COA bank —</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber} · {a.accountName}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={mapping || !selected || selected === currentMappingId}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {mapping ? 'Saving…' : currentMappingId ? 'Update' : 'Map'}
        </button>
        {mapState?.ok && <span className="text-xs text-emerald-600">✓</span>}
        {mapState?.error && <span className="text-xs text-red-600">{mapState.error}</span>}
      </form>

      <form action={promoteAction}>
        <input type="hidden" name="plaidAccountId" value={plaidAccountId} />
        <button
          type="submit"
          disabled={promoting || !currentMappingId}
          title={promoteTitle}
          className={`rounded-md px-2 py-1 text-xs disabled:opacity-50 ${
            inScope
              ? 'border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          }`}
        >
          {promoting ? '…' : promoteLabel}
        </button>
        {promoteState?.error && <span className="ml-2 text-xs text-red-600">{promoteState.error}</span>}
        {promoteState?.promoted != null && (
          <span className="ml-2 text-xs text-emerald-600">
            ✓ {promoteState.promoted} promoted{promoteState.skipped ? `, ${promoteState.skipped} skipped` : ''}
          </span>
        )}
      </form>
    </div>
  );
}

export { fmt };
