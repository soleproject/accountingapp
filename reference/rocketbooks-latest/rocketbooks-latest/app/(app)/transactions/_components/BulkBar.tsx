'use client';

import { useActionState, useEffect, useState } from 'react';
import { bulkCategorize, type BulkResult } from '../_actions/bulkCategorize';
import { approveTransactionsBulk, type ApproveState } from '../_actions/approveTransaction';
import { bulkTag, type BulkTagState } from '../_actions/bulkTag';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
}

export interface BulkTagDimension {
  entityType: string;
  shortLabel: string;
  emoji: string;
  options: Array<{ id: string; label: string; subLabel?: string }>;
}

interface Props {
  accounts?: Account[];
  /** Optional initial tag dimensions. The transactions page intentionally omits
   *  this on first render so non-critical tag option queries are deferred until
   *  rows are actually selected. */
  tagDimensions?: BulkTagDimension[];
}

const KEEP = '__keep__';

export function BulkBar({ accounts = [], tagDimensions = [] }: Props) {
  const [catState, catAction, catPending] = useActionState<BulkResult | undefined, FormData>(bulkCategorize, undefined);
  const [appState, appAction, appPending] = useActionState<ApproveState | undefined, FormData>(approveTransactionsBulk, undefined);
  const [tagState, tagAction, tagPending] = useActionState<BulkTagState | undefined, FormData>(bulkTag, undefined);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [categoryAccounts, setCategoryAccounts] = useState<Account[]>(accounts);
  const [accountsLoaded, setAccountsLoaded] = useState(accounts.length > 0);
  const [lazyTagDimensions, setLazyTagDimensions] = useState<BulkTagDimension[]>(tagDimensions);
  const [tagPicks, setTagPicks] = useState<Record<string, string>>(
    Object.fromEntries(tagDimensions.map((d) => [d.entityType, KEEP])),
  );

  useEffect(() => {
    const recount = () => {
      const ids = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked')).map(
        (i) => i.value,
      );
      setSelectedIds(ids);
    };
    document.addEventListener('change', recount);
    recount();
    return () => document.removeEventListener('change', recount);
  }, []);

  const count = selectedIds.length;

  useEffect(() => {
    if (count === 0 || accountsLoaded) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/transactions/filter-options?kind=accounts', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { categoryAccounts?: Account[] };
        if (Array.isArray(data.categoryAccounts)) setCategoryAccounts(data.categoryAccounts);
        setAccountsLoaded(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [count, accountsLoaded]);

  useEffect(() => {
    if (count === 0 || lazyTagDimensions.length > 0) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/transactions/tag-dimensions', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { dimensions?: BulkTagDimension[] };
        const dimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
        setLazyTagDimensions(dimensions);
        setTagPicks((prev) => ({
          ...Object.fromEntries(dimensions.map((d) => [d.entityType, KEEP])),
          ...prev,
        }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [count, lazyTagDimensions.length]);

  if (count === 0 && !catState && !appState && !tagState) return null;

  const hasTagDim = lazyTagDimensions.some((d) => d.options.length > 0);
  const tagDirty = Object.values(tagPicks).some((v) => v !== KEEP);

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-900/20">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-blue-900 dark:text-blue-100">{count} selected</span>

        <form id="bulk-form" action={catAction} className="contents">
          <select
            name="categoryAccountId"
            required
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">— Category account —</option>
            {categoryAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={catPending || count === 0}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {catPending ? 'Posting…' : `Categorize ${count} & post JEs`}
          </button>
        </form>

        <form action={appAction} className="contents">
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <button
            type="submit"
            disabled={appPending || count === 0}
            className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
          >
            {appPending ? 'Approving…' : `Approve ${count}`}
          </button>
        </form>

        {catState?.error && <span className="text-red-600">{catState.error}</span>}
        {catState?.ok && (
          <span className="text-emerald-700 dark:text-emerald-300">
            Posted {catState.posted}{catState.skipped ? `, skipped ${catState.skipped}` : ''}.
          </span>
        )}
        {appState?.error && <span className="text-red-600">{appState.error}</span>}
        {appState?.ok && (
          <span className="text-emerald-700 dark:text-emerald-300">Approved {appState.count}.</span>
        )}
      </div>

      {hasTagDim && (
        <form
          action={tagAction}
          className="flex flex-wrap items-center gap-2 border-t border-blue-200 pt-2 dark:border-blue-800"
        >
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-xs font-medium uppercase tracking-wide text-blue-900/70 dark:text-blue-200/70">
            Tags:
          </span>
          {lazyTagDimensions.map((d) =>
            d.options.length === 0 ? null : (
              <label
                key={d.entityType}
                className="flex items-center gap-1 text-xs text-blue-900/80 dark:text-blue-200/80"
              >
                <span>
                  <span aria-hidden>{d.emoji}</span> {d.shortLabel}
                </span>
                <select
                  name={d.entityType}
                  value={tagPicks[d.entityType] ?? KEEP}
                  onChange={(e) =>
                    setTagPicks((p) => ({ ...p, [d.entityType]: e.target.value }))
                  }
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value={KEEP}>— keep —</option>
                  <option value="">(clear)</option>
                  {d.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                      {o.subLabel ? ` (${o.subLabel})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ),
          )}
          <button
            type="submit"
            disabled={tagPending || count === 0 || !tagDirty}
            className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50"
          >
            {tagPending ? 'Tagging…' : `Tag ${count}`}
          </button>
          {tagState?.error && <span className="text-xs text-red-600">{tagState.error}</span>}
          {tagState?.ok && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300">
              Tagged {tagState.tagged}{tagState.skipped ? `, skipped ${tagState.skipped} (no JE)` : ''}.
            </span>
          )}
        </form>
      )}
    </div>
  );
}
