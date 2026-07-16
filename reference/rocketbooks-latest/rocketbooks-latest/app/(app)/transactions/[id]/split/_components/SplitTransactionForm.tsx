'use client';

import { useActionState, useMemo, useRef, useState, useEffect } from 'react';
import type { SplitTransactionState } from '../../_actions/splitTransaction';
import { groupAccountsByGaap } from '../../_components/account-groups';
import { CategorySelect, type BillOption, type InvoiceOption } from '../../_components/CategorySelect';
import { ContactSelect } from '../../_components/ContactSelect';

interface Account {
  id: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
}

interface Contact {
  id: string;
  name: string;
}

interface Line {
  id: number;
  categoryAccountId: string;
  intent: '' | 'bill_payment' | 'invoice_payment';
  intentTargetId: string;
  amount: string;
  memo: string;
  contactId: string;
  memoShown: boolean;
  contactShown: boolean;
}

let nextId = 0;
const blankLine = (preset?: Partial<Line>): Line => ({
  id: ++nextId,
  categoryAccountId: preset?.categoryAccountId ?? '',
  intent: preset?.intent ?? '',
  intentTargetId: preset?.intentTargetId ?? '',
  amount: preset?.amount ?? '',
  memo: preset?.memo ?? '',
  contactId: preset?.contactId ?? '',
  memoShown: !!preset?.memo,
  contactShown: !!preset?.contactId,
});

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

interface Props {
  action: (
    prev: SplitTransactionState | undefined,
    formData: FormData,
  ) => Promise<SplitTransactionState | undefined>;
  transactionAmount: number;
  categoryAccounts: Account[];
  contacts: Contact[];
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  /** Controlled by the panel — same values passed to the categorize form
   *  so user input persists across mode switches. */
  date: string;
  description: string;
  accountId: string;
  type: 'deposit' | 'withdrawal' | '';
  /** Seed when the txn already had a single category — start the first
   *  split line populated so the user can split FROM it. */
  initialCategoryAccountId?: string | null;
  /** When the txn is already split, seed the form with existing rows. */
  initialLines?: Array<{
    categoryAccountId: string;
    amount: string;
    memo: string;
    contactId: string;
    intent?: '' | 'bill_payment' | 'invoice_payment';
    intentTargetId?: string;
  }>;
  /** Optional cancel handler — rendered as a small link next to the
   *  "Split transaction" heading. */
  onCancel?: () => void;
}

export function SplitTransactionForm({
  action,
  transactionAmount,
  categoryAccounts,
  contacts,
  outstandingBills,
  outstandingInvoices,
  date,
  description,
  accountId,
  type,
  initialCategoryAccountId,
  initialLines,
  onCancel,
}: Props) {
  const [state, formAction, pending] = useActionState<SplitTransactionState | undefined, FormData>(
    action,
    undefined,
  );
  const accountGroups = useMemo(() => groupAccountsByGaap(categoryAccounts), [categoryAccounts]);
  const [lines, setLines] = useState<Line[]>(() => {
    if (initialLines && initialLines.length > 0) {
      return initialLines.map((l) => blankLine(l));
    }
    return [blankLine({ categoryAccountId: initialCategoryAccountId ?? '' }), blankLine()];
  });

  const update = (id: number, patch: Partial<Line>) =>
    setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const totalAllocated = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.amount) || 0), 0),
    [lines],
  );
  const remaining = Math.round((transactionAmount - totalAllocated) * 100) / 100;
  const balanced = Math.abs(remaining) < 0.005;

  const fillRemaining = () => {
    if (remaining <= 0) return;
    const lastEmpty = [...lines].reverse().find((l) => !l.amount);
    if (lastEmpty) update(lastEmpty.id, { amount: remaining.toFixed(2) });
  };

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="userDescription" value={description} />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="type" value={type} />
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h3 className="text-base font-medium">Split transaction</h3>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
              >
                Cancel
              </button>
            )}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Original amount{' '}
            <span className="ml-1 font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
              {fmt(transactionAmount)}
            </span>
          </div>
        </div>

        {lines.map((line, idx) => (
          <SplitLineCard
            key={line.id}
            idx={idx}
            line={line}
            accountGroups={accountGroups}
            outstandingBills={outstandingBills}
            outstandingInvoices={outstandingInvoices}
            contacts={contacts}
            canRemove={lines.length > 2}
            onChange={(patch) => update(line.id, patch)}
            onRemove={() =>
              setLines((cur) => (cur.length > 2 ? cur.filter((l) => l.id !== line.id) : cur))
            }
          />
        ))}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900/30">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setLines((cur) => [...cur, blankLine()])}
              className="rounded-full border border-blue-500 px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40"
            >
              + Split transaction
            </button>
            <button
              type="button"
              onClick={fillRemaining}
              disabled={remaining <= 0}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Fill remaining
            </button>
          </div>
          <div className="flex items-center gap-4 text-xs tabular-nums">
            <span className="text-zinc-500">
              Allocated <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmt(totalAllocated)}</span>
            </span>
            <span
              className={
                balanced
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-400'
              }
            >
              Remaining <span className="font-medium">{fmt(remaining)}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !balanced || lines.length < 2}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Saving…' : 'Save split'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}

interface CardProps {
  idx: number;
  line: Line;
  accountGroups: Array<{ label: string; accounts: Account[] }>;
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  contacts: Contact[];
  canRemove: boolean;
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}

function SplitLineCard({
  idx,
  line,
  accountGroups,
  outstandingBills,
  outstandingInvoices,
  contacts,
  canRemove,
  onChange,
  onRemove,
}: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Split amount
          </label>
          <input
            name={`lines[${idx}].amount`}
            type="number"
            step="0.01"
            min="0.01"
            value={line.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            required
            placeholder="0.00"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <div className="flex min-w-[14rem] flex-[2] flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Category</label>
          <CategorySelect
            namePrefix={`lines[${idx}].`}
            value={{
              categoryAccountId: line.categoryAccountId,
              intent: line.intent,
              intentTargetId: line.intentTargetId,
            }}
            onChange={(next) =>
              onChange({
                categoryAccountId: next.categoryAccountId,
                intent: next.intent,
                intentTargetId: next.intentTargetId,
              })
            }
            accountGroups={accountGroups}
            outstandingBills={outstandingBills}
            outstandingInvoices={outstandingInvoices}
            required
          />
        </div>

        <div className="flex items-center gap-1 self-end pb-0.5">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="More options"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-md dark:border-zinc-800 dark:bg-zinc-950">
                <button
                  type="button"
                  disabled={line.contactShown}
                  onClick={() => {
                    onChange({ contactShown: true });
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-900"
                >
                  Add customer
                </button>
                <button
                  type="button"
                  disabled={line.memoShown}
                  onClick={() => {
                    onChange({ memoShown: true });
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-900"
                >
                  Add memo
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label="Remove split line"
            title={canRemove ? 'Remove' : 'A split needs at least 2 lines'}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:text-red-600 disabled:opacity-30"
          >
            ×
          </button>
        </div>
      </div>

      {line.contactShown && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Customer</label>
            <ContactSelect
              name={`lines[${idx}].contactId`}
              value={line.contactId}
              onChange={(id) => onChange({ contactId: id })}
              contacts={contacts}
              placeholder="— Select a customer —"
            />
          </div>
          <button
            type="button"
            onClick={() => onChange({ contactShown: false, contactId: '' })}
            aria-label="Remove customer field"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:text-red-600"
          >
            ×
          </button>
        </div>
      )}

      {line.memoShown && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</label>
            <input
              name={`lines[${idx}].memo`}
              value={line.memo}
              onChange={(e) => onChange({ memo: e.target.value })}
              placeholder="Line memo"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <button
            type="button"
            onClick={() => onChange({ memoShown: false, memo: '' })}
            aria-label="Remove memo field"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:text-red-600"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
