'use client';

import { useActionState, useState, useTransition } from 'react';
import { updateReceiptLines, type UpdateReceiptLinesState } from '../_actions/updateReceiptLines';
import { postReceipt } from '../_actions/postReceipt';
import { manualLinkReceiptToTransaction } from '../_actions/manualLinkReceiptToTransaction';

export interface AccountOption {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

export interface ReceiptLineRow {
  id: string;
  description: string;
  amount: number;
  expenseAccountId: string | null;
  suggestedAccountId: string | null;
}

export interface TxnCandidate {
  id: string;
  date: string | null;
  amount: number;
  description: string | null;
  contactName: string | null;
}

interface Props {
  receiptId: string;
  posted: boolean;
  sourceAccountId: string | null;
  lines: ReceiptLineRow[];
  expenseAccounts: AccountOption[];
  sourceAccounts: AccountOption[];
  /** Veryfi-signed image URL. Expires ~24h after upload; the <img>'s
   *  onError falls back to a placeholder for stale rows. */
  imageUrl?: string | null;
  /** Veryfi-signed PDF URL (when the source upload was a PDF). */
  pdfUrl?: string | null;
  /** Transactions in the org not currently linked to any receipt —
   *  populates the manual link dropdown. */
  txnCandidates?: TxnCandidate[];
  /** Transaction id this receipt is already linked to (if any). When
   *  set, the manual link picker shows the current link and disables
   *  re-link from here. */
  linkedTransactionId?: string | null;
}

function formatAmount(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function ReceiptLinesEditor({
  receiptId,
  posted,
  sourceAccountId,
  lines,
  expenseAccounts,
  sourceAccounts,
  imageUrl = null,
  pdfUrl = null,
  txnCandidates = [],
  linkedTransactionId = null,
}: Props) {
  const [imageBroken, setImageBroken] = useState(false);
  const [saveState, saveAction, savePending] = useActionState<UpdateReceiptLinesState | undefined, FormData>(
    updateReceiptLines,
    undefined,
  );
  const [posting, startPost] = useTransition();
  const [linking, startLink] = useTransition();
  const [linkError, setLinkError] = useState<string | null>(null);

  const onPickTxn = (txnId: string) => {
    if (!txnId || linking) return;
    setLinkError(null);
    startLink(async () => {
      const result = await manualLinkReceiptToTransaction(receiptId, txnId);
      if (result?.error) setLinkError(result.error);
    });
  };
  const [postError, setPostError] = useState<string | null>(null);

  const allCategorized = lines.length > 0 && lines.every((l) => l.expenseAccountId);
  const canPost = !posted && allCategorized && !!sourceAccountId;

  const onPost = () => {
    if (!canPost || posting) return;
    if (!window.confirm('Post this receipt to the general ledger? A journal entry will be created.')) return;
    startPost(async () => {
      const result = await postReceipt(receiptId);
      if (result?.error) setPostError(result.error);
      else setPostError(null);
    });
  };

  const accountLabel = (a: AccountOption) => `${a.accountNumber} ${a.accountName}`;

  const hasPreview = !!imageUrl && !imageBroken;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <form action={saveAction} className="flex min-w-0 flex-1 flex-col gap-4">
        <input type="hidden" name="receiptId" value={receiptId} />

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Line items
          </h2>
          <span className="text-xs text-zinc-500">
            {allCategorized ? 'All lines categorized' : `${lines.filter((l) => l.expenseAccountId).length} / ${lines.length} categorized`}
          </span>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-zinc-50/50 text-left dark:bg-zinc-900/50">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  No line items extracted from this receipt.
                </td>
              </tr>
            )}
            {lines.map((l) => {
              const currentValue = l.expenseAccountId ?? l.suggestedAccountId ?? '';
              const showSuggestedBadge = !l.expenseAccountId && !!l.suggestedAccountId;
              return (
                <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">{l.description}</td>
                  <td className="px-4 py-2 text-right align-top tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatAmount(l.amount)}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <div className="flex items-center gap-2">
                      <select
                        name={`line.${l.id}.accountId`}
                        defaultValue={currentValue}
                        disabled={posted}
                        className={`w-full rounded-md border px-2 py-1 text-sm dark:bg-zinc-950 ${
                          showSuggestedBadge
                            ? 'border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
                            : 'border-zinc-300 bg-white dark:border-zinc-700'
                        }`}
                      >
                        <option value="">— pick an account —</option>
                        {expenseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {accountLabel(a)}
                          </option>
                        ))}
                      </select>
                      {showSuggestedBadge && (
                        <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          AI suggested
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Paid from</span>
            <select
              name="sourceAccountId"
              defaultValue={sourceAccountId ?? ''}
              disabled={posted}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— choose the funding account —</option>
              {sourceAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
            <span className="text-xs text-zinc-500">
              Cash, bank, credit card, or owner&apos;s funds — credited for the total when posted.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Link to a transaction
            </span>
            <select
              // No `name=` — this isn't a save-along-with-the-form field;
              // selecting a txn fires its own server action immediately.
              defaultValue={linkedTransactionId ?? ''}
              disabled={posted || linking || !!linkedTransactionId}
              onChange={(e) => {
                if (e.target.value) onPickTxn(e.target.value);
              }}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:disabled:bg-zinc-900"
            >
              <option value="">
                {linkedTransactionId ? '— already linked —' : '— pick an existing transaction —'}
              </option>
              {txnCandidates.map((t) => {
                const amt = Math.abs(t.amount).toFixed(2);
                const desc = t.description ?? t.contactName ?? '—';
                return (
                  <option key={t.id} value={t.id}>
                    {t.date ?? '—'} · ${amt} · {desc}
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-zinc-500">
              {linking
                ? 'Linking…'
                : linkedTransactionId
                  ? 'Use Undo on the matches panel above to re-link.'
                  : 'Pick a transaction to apply this receipt against it. Runs the same JE / splits flow auto-apply uses.'}
            </span>
            {linkError && <span className="text-xs text-red-600">{linkError}</span>}
          </label>
        </div>
      </section>

      {!posted && (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={savePending}
            className="rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            {savePending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={onPost}
            disabled={!canPost || posting}
            title={
              !allCategorized
                ? 'Every line must have an account first'
                : !sourceAccountId
                  ? 'Pick a paid-from account first'
                  : 'Post to GL'
            }
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {posting ? 'Posting…' : 'Post to GL'}
          </button>
          {saveState?.error && <span className="text-sm text-red-600">{saveState.error}</span>}
          {postError && <span className="text-sm text-red-600">{postError}</span>}
        </div>
      )}
      </form>

      {/* Receipt image preview — sticky on desktop so it stays visible
          while the user scrolls through long line-item lists. Veryfi
          URLs are signed and expire ~24h after upload; onError flips
          imageBroken so the placeholder takes over for stale rows. */}
      {(imageUrl || pdfUrl) && (
        <aside className="w-full lg:sticky lg:top-4 lg:w-80 xl:w-96">
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                Receipt
              </h2>
              {pdfUrl && (
                <a
                  href={pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
                >
                  Open PDF ↗
                </a>
              )}
              {!pdfUrl && imageUrl && !imageBroken && (
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
                >
                  Full size ↗
                </a>
              )}
            </header>
            <div className="bg-zinc-50 p-2 dark:bg-zinc-900">
              {hasPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl!}
                  alt="Receipt scan"
                  onError={() => setImageBroken(true)}
                  className="mx-auto block max-h-[640px] w-auto rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                />
              ) : (
                <div className="flex h-48 flex-col items-center justify-center gap-2 rounded border border-dashed border-zinc-300 text-center text-xs text-zinc-500 dark:border-zinc-700">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                  <p>Receipt image not available.</p>
                  <p className="text-[10px] text-zinc-400">Veryfi URLs expire ~24h after upload.</p>
                </div>
              )}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
