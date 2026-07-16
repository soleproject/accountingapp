'use client';

import { useActionState, useEffect, useState } from 'react';
import { mergeContacts, type MergeContactsState } from '../_actions/mergeContacts';
import {
  bulkArchiveContacts,
  bulkRestoreContacts,
  type DeleteContactState,
  type RestoreContactState,
} from '../_actions/deleteContact';

interface ContactOption {
  id: string;
  contactName: string;
}

/**
 * Bulk-merge bar for the contacts list.
 *
 * Behavior:
 *   1. User checks ≥2 contacts in the table (each row has a checkbox with
 *      name="contactIds" form="contacts-merge-form" and value=contactId).
 *   2. This bar appears, listing the selected contacts and a target picker.
 *   3. User picks the target (the survivor) — defaults to the first selected.
 *   4. Submit → mergeContacts rewires every cross-table reference and
 *      deletes the sources.
 *
 * Form ergonomics: the row checkboxes carry name="contactIds" so they
 * submit naturally with this form. We sync them into local state via DOM
 * change events so we can render the target dropdown.
 */
export function MergeBar({
  allContacts,
  currentStatus,
}: {
  allContacts: ContactOption[];
  /** Drives which secondary bulk button shows: archive (active view) vs restore (archived view). */
  currentStatus: 'active' | 'archived' | 'all';
}) {
  const [mergeState, mergeAction, mergePending] = useActionState<MergeContactsState | undefined, FormData>(
    mergeContacts,
    undefined,
  );
  const [archiveState, archiveAction, archivePending] = useActionState<DeleteContactState | undefined, FormData>(
    bulkArchiveContacts,
    undefined,
  );
  const [restoreState, restoreAction, restorePending] = useActionState<RestoreContactState | undefined, FormData>(
    bulkRestoreContacts,
    undefined,
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targetId, setTargetId] = useState<string>('');

  useEffect(() => {
    const recount = () => {
      const ids = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="contactIds"]:checked'),
      ).map((i) => i.value);
      setSelectedIds(ids);
      // Auto-pick the first selected as default target if current target
      // isn't in the list anymore.
      setTargetId((prev) => (prev && ids.includes(prev) ? prev : ids[0] ?? ''));
    };
    document.addEventListener('change', recount);
    recount();
    return () => document.removeEventListener('change', recount);
  }, []);

  // Show the bar as soon as anything is selected (Archive/Restore works
  // with 1+), and keep it visible while we display a result toast.
  if (selectedIds.length < 1 && !mergeState && !archiveState && !restoreState) return null;

  const byId = new Map(allContacts.map((c) => [c.id, c.contactName]));
  const selectedNames = selectedIds.map((id) => byId.get(id) ?? id);
  const canMerge = selectedIds.length >= 2;

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-900/20">
      <span className="font-medium text-blue-900 dark:text-blue-100">
        {selectedIds.length} selected
      </span>

      {/* MERGE — the row checkboxes (name="contactIds") link via form="contacts-merge-form".
          We also render hidden sourceIds inputs as a backup. */}
      <form
        id="contacts-merge-form"
        action={mergeAction}
        onSubmit={(e) => {
          if (!canMerge) {
            e.preventDefault();
            return;
          }
          const survivorName = byId.get(targetId) ?? targetId;
          const others = selectedIds.filter((id) => id !== targetId).length;
          const msg = `Merge ${others} contact(s) into "${survivorName}"? Cross-table references (transactions, JEs, GL, bills, invoices) will be rewired and the source contacts will be deleted.`;
          if (!confirm(msg)) e.preventDefault();
        }}
        className="contents"
      >
        {selectedIds.map((id) => (
          <input key={`m-${id}`} type="hidden" name="sourceIds" value={id} />
        ))}
        <label className="flex items-center gap-2">
          <span className="text-xs text-blue-900 dark:text-blue-100">Merge into:</span>
          <select
            name="targetId"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={!canMerge}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
          >
            {canMerge ? (
              selectedIds.map((id) => (
                <option key={id} value={id}>
                  {byId.get(id) ?? id}
                </option>
              ))
            ) : (
              <option value="">— select 2+ to merge —</option>
            )}
          </select>
        </label>
        <button
          type="submit"
          disabled={mergePending || archivePending || !canMerge || !targetId}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {mergePending ? 'Merging…' : canMerge ? `Merge ${selectedIds.length - 1} into target` : 'Merge'}
        </button>
      </form>

      {/* ARCHIVE / RESTORE — secondary bulk action. Which one shows depends
          on the active list view: when looking at archived contacts, the
          button restores instead of archiving (an archive on archived rows
          would be a no-op). When viewing 'all', archive is the default. */}
      {currentStatus === 'archived' ? (
        <form
          action={restoreAction}
          onSubmit={(e) => {
            if (selectedIds.length === 0) {
              e.preventDefault();
              return;
            }
            const msg = `Restore ${selectedIds.length} contact${selectedIds.length === 1 ? '' : 's'}? They'll show up in active pickers again.`;
            if (!confirm(msg)) e.preventDefault();
          }}
          className="contents"
        >
          {selectedIds.map((id) => (
            <input key={`r-${id}`} type="hidden" name="sourceIds" value={id} />
          ))}
          <button
            type="submit"
            disabled={mergePending || restorePending || selectedIds.length === 0}
            className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
          >
            {restorePending ? 'Restoring…' : `Restore ${selectedIds.length}`}
          </button>
        </form>
      ) : (
        <form
          action={archiveAction}
          onSubmit={(e) => {
            if (selectedIds.length === 0) {
              e.preventDefault();
              return;
            }
            const msg = `Archive ${selectedIds.length} contact${selectedIds.length === 1 ? '' : 's'}? They'll stop appearing in pickers but transactions / JEs that reference them will keep their attribution.`;
            if (!confirm(msg)) e.preventDefault();
          }}
          className="contents"
        >
          {selectedIds.map((id) => (
            <input key={`a-${id}`} type="hidden" name="sourceIds" value={id} />
          ))}
          <button
            type="submit"
            disabled={mergePending || archivePending || selectedIds.length === 0}
            className="rounded-md border border-rose-400 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50"
          >
            {archivePending ? 'Archiving…' : `Archive ${selectedIds.length}`}
          </button>
        </form>
      )}

      {selectedNames.length > 0 && !mergePending && !archivePending && !restorePending && (
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          {selectedNames.slice(0, 5).join(', ')}
          {selectedNames.length > 5 ? `, +${selectedNames.length - 5} more` : ''}
        </span>
      )}

      {mergeState?.error && <span className="text-red-600">{mergeState.error}</span>}
      {mergeState?.ok && (
        <span className="text-emerald-700 dark:text-emerald-300">
          Merged {mergeState.deletedContacts ?? 0} contact{mergeState.deletedContacts === 1 ? '' : 's'}.
          {mergeState.rewired && summarizeRewired(mergeState.rewired)}
        </span>
      )}
      {archiveState?.error && <span className="text-red-600">{archiveState.error}</span>}
      {archiveState?.ok && (
        <span className="text-emerald-700 dark:text-emerald-300">
          Archived {archiveState.archived ?? 0} contact{archiveState.archived === 1 ? '' : 's'}.
        </span>
      )}
      {restoreState?.error && <span className="text-red-600">{restoreState.error}</span>}
      {restoreState?.ok && (
        <span className="text-emerald-700 dark:text-emerald-300">
          Restored {restoreState.restored ?? 0} contact{restoreState.restored === 1 ? '' : 's'}.
        </span>
      )}
    </div>
  );
}

/** "rewired 23 transactions, 6 JE lines, 6 GL rows" — readable summary. */
function summarizeRewired(rewired: Record<string, number>): string {
  const interesting = Object.entries(rewired).filter(([, n]) => n > 0);
  if (interesting.length === 0) return '';
  const total = interesting.reduce((s, [, n]) => s + n, 0);
  return ` Rewired ${total} reference${total === 1 ? '' : 's'} across ${interesting.length} table${interesting.length === 1 ? '' : 's'}.`;
}
