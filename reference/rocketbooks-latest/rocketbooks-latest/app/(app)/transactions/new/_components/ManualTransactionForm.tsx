'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { createManualTransaction, type CreateManualTransactionState } from '../_actions/createManualTransaction';
import { createSplitManualTransaction } from '../_actions/createSplitManualTransaction';
import { startUnlockCheckoutAction } from '@/app/(app)/billing/_actions/billing';
import { CategorySelect, type BillOption, type CategoryPickerValue, type InvoiceOption } from '../../[id]/_components/CategorySelect';
import { groupAccountsByGaap } from '../../[id]/_components/account-groups';

interface Account {
  id: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
}
interface Contact { id: string; name: string; }

/** Trust beneficiary option (Phase 4d). When this list is non-empty AND
 *  the picked category is in perBeneficiaryAccountIds, the form renders a
 *  required beneficiary picker. Non-qualifying beneficiaries gray out on
 *  815/820 accounts (passed via foodOrClothingAccountIds). */
export interface BeneficiaryOption {
  id: string;
  fullName: string;
  qualifies: boolean;
  ageNote: string;
}

/** Initial values for edit mode. Omit on create. */
export interface ManualTransactionInitial {
  transactionId: string;
  type: 'deposit' | 'withdrawal';
  date: string;
  amount: number;
  bankAccountId: string | null;
  contactId: string | null;
  description: string | null;
  // Single-mode current categorization (use these when there are no splits).
  categoryAccountId: string | null;
  intent: '' | 'bill_payment' | 'invoice_payment';
  intentTargetId: string;
  // Existing splits (presence => start in split mode).
  splits: Array<{
    type: 'deposit' | 'withdrawal';
    categoryAccountId: string;
    intent: '' | 'bill_payment' | 'invoice_payment';
    intentTargetId: string;
    amount: string;
    memo: string;
    contactId: string;
  }>;
}

export interface ManualTransactionActions {
  singleAction: (
    prev: CreateManualTransactionState | undefined,
    formData: FormData,
  ) => Promise<CreateManualTransactionState | undefined>;
  splitAction: (
    prev: CreateManualTransactionState | undefined,
    formData: FormData,
  ) => Promise<CreateManualTransactionState | undefined>;
  /** Edit-only. Collapses the split back to a single category (or
   *  undoes the receipt-match flow). Rendered as a "Remove split"
   *  button alongside the primary Update when the form is in split
   *  mode AND there are existing splits on the txn. */
  unsplitAction?: (
    prev: CreateManualTransactionState | undefined,
    formData: FormData,
  ) => Promise<CreateManualTransactionState | undefined>;
}

interface Props {
  defaultType: 'deposit' | 'withdrawal';
  bankAccounts: Account[];
  /** Full CoA passed through — CategorySelect groups by gaap_type. With
   *  per-line Type on splits, a single line can hit any account, so we
   *  no longer pre-filter by income/expense. */
  categoryAccounts: Account[];
  contacts: Contact[];
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  /** Edit-mode initial values. Omit on the create page. */
  initial?: ManualTransactionInitial;
  /** Override the default create-mode server actions. Used by the edit
   *  page to wire categorize / splitTransaction through the same UI. */
  actions?: ManualTransactionActions;
  /** Trust beneficiaries on this org (Phase 4d). Empty/undefined on
   *  non-trust orgs — the picker won't render. */
  beneficiaries?: readonly BeneficiaryOption[];
  /** chart_of_accounts.id values for the per-beneficiary accounts on this
   *  org (815/820/310/635). When the picked category is in this set, the
   *  beneficiary picker is rendered and required. */
  perBeneficiaryAccountIds?: readonly string[];
  /** Subset of perBeneficiaryAccountIds that require a QUALIFYING
   *  beneficiary (under 21 OR incapacitated) — accounts 815 and 820.
   *  Non-qualifying beneficiaries gray out in the picker for these. */
  foodOrClothingAccountIds?: readonly string[];
  /** Existing line-level beneficiary on the txn (edit mode). */
  initialBeneficiaryId?: string | null;
  /** Open directly in split mode — the AI "Split deposit" handoff (?mode=split). */
  startInSplitMode?: boolean;
}

interface SplitLineRow {
  id: number;
  /** Per-line direction. Lets one split mix inflow (rental income credit
   *  to AR) and outflow (mgmt fee bill payment debit to AP) on the same
   *  transaction — bank gets the net. Defaults to the txn-level type but
   *  can be flipped per line. */
  type: 'deposit' | 'withdrawal';
  categoryAccountId: string;
  intent: '' | 'bill_payment' | 'invoice_payment';
  intentTargetId: string;
  amount: string;
  memo: string;
  contactId: string;
  memoShown: boolean;
  contactShown: boolean;
}

let nextLineId = 0;
const blankLine = (preset?: Partial<SplitLineRow>): SplitLineRow => ({
  id: ++nextLineId,
  type: preset?.type ?? 'withdrawal',
  categoryAccountId: preset?.categoryAccountId ?? '',
  intent: preset?.intent ?? '',
  intentTargetId: preset?.intentTargetId ?? '',
  amount: preset?.amount ?? '',
  memo: preset?.memo ?? '',
  contactId: preset?.contactId ?? '',
  memoShown: !!preset?.memo,
  contactShown: !!preset?.contactId,
});

const inputClass =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const labelClass = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

export function ManualTransactionForm({
  defaultType,
  bankAccounts,
  categoryAccounts,
  contacts,
  outstandingBills,
  outstandingInvoices,
  initial,
  actions,
  beneficiaries,
  perBeneficiaryAccountIds,
  foodOrClothingAccountIds,
  initialBeneficiaryId,
  startInSplitMode,
}: Props) {
  const perBeneficiarySet = useMemo(
    () => new Set(perBeneficiaryAccountIds ?? []),
    [perBeneficiaryAccountIds],
  );
  const foodOrClothingSet = useMemo(
    () => new Set(foodOrClothingAccountIds ?? []),
    [foodOrClothingAccountIds],
  );
  const [beneficiaryId, setBeneficiaryId] = useState<string>(initialBeneficiaryId ?? '');
  const isEdit = !!initial;
  const [type, setType] = useState<'deposit' | 'withdrawal'>(initial?.type ?? defaultType);
  const [mode, setMode] = useState<'single' | 'split'>(
    startInSplitMode || (initial && initial.splits.length > 0) ? 'split' : 'single',
  );
  const accountGroups = useMemo(() => groupAccountsByGaap(categoryAccounts), [categoryAccounts]);
  const today = new Date().toISOString().slice(0, 10);

  // Shared form state — kept here so toggling between single and split
  // doesn't blow away what the user already typed.
  const [date, setDate] = useState(initial?.date ?? today);
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [bankAccountId, setBankAccountId] = useState(initial?.bankAccountId ?? '');
  const [contactId, setContactId] = useState(initial?.contactId ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // Single mode only.
  const [category, setCategory] = useState<CategoryPickerValue>({
    categoryAccountId: initial?.categoryAccountId ?? '',
    intent: initial?.intent ?? '',
    intentTargetId: initial?.intentTargetId ?? '',
  });
  // Split mode only. Lines default to the current txn type but each can
  // be flipped via its own Type pill.
  const [lines, setLines] = useState<SplitLineRow[]>(() => {
    if (initial && initial.splits.length > 0) {
      return initial.splits.map((s) => blankLine(s));
    }
    return [
      blankLine({ type: initial?.type ?? defaultType }),
      blankLine({ type: initial?.type ?? defaultType }),
    ];
  });

  const [singleState, singleAction, singlePending] = useActionState<CreateManualTransactionState | undefined, FormData>(
    actions?.singleAction ?? createManualTransaction,
    undefined,
  );
  const [splitState, splitAction, splitPending] = useActionState<CreateManualTransactionState | undefined, FormData>(
    actions?.splitAction ?? createSplitManualTransaction,
    undefined,
  );
  const [unsplitState, unsplitAction, unsplitPending] = useActionState<CreateManualTransactionState | undefined, FormData>(
    actions?.unsplitAction ?? (async () => undefined),
    undefined,
  );

  const state = mode === 'single' ? singleState : splitState;
  const pending = mode === 'single' ? singlePending : splitPending;
  const formAction = mode === 'single' ? singleAction : splitAction;

  const updateLine = (id: number, patch: Partial<SplitLineRow>) =>
    setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => setLines((cur) => [...cur, blankLine({ type })]);
  const removeLine = (id: number) =>
    setLines((cur) => (cur.length <= 2 ? cur : cur.filter((l) => l.id !== id)));

  const amountNum = Number(amount) || 0;
  // Per-line type means the bank line balances the NET, not the line
  // sum. inflow - outflow must equal the signed txn amount: positive on
  // a deposit, negative on a withdrawal.
  const { inflow, outflow } = useMemo(() => {
    let dep = 0;
    let wd = 0;
    for (const l of lines) {
      const v = Number(l.amount) || 0;
      if (l.type === 'deposit') dep += v;
      else wd += v;
    }
    return { inflow: Math.round(dep * 100) / 100, outflow: Math.round(wd * 100) / 100 };
  }, [lines]);
  const net = Math.round((inflow - outflow) * 100) / 100;
  const signedAmount = (type === 'deposit' ? 1 : -1) * Math.round(amountNum * 100) / 100;
  const balanced = amountNum > 0 && Math.abs(net - signedAmount) < 0.005;
  const balanceDelta = Math.round((signedAmount - net) * 100) / 100;

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="type" value={type} />
      {initial && <input type="hidden" name="transactionId" value={initial.transactionId} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          {(['deposit', 'withdrawal'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded px-3 py-1 transition-colors ${
                type === t
                  ? t === 'deposit'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-amber-600 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              {t === 'deposit' ? 'Deposit' : 'Withdrawal'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setMode((m) => (m === 'single' ? 'split' : 'single'))}
          className={`rounded-full border px-4 py-1 text-xs font-medium transition-colors ${
            mode === 'split'
              ? 'border-violet-500 bg-violet-100 text-violet-700 dark:border-violet-400 dark:bg-violet-900/40 dark:text-violet-200'
              : 'border-blue-500 text-blue-600 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40'
          }`}
        >
          {mode === 'split' ? '↩ Single category' : '⇄ Split transaction'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Date</label>
          <input
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Amount</label>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            readOnly={isEdit}
            // Edit mode keeps amount read-only: categorize / split actions
            // don't currently rewrite it, and changing it without a JE
            // rewrite would desync the books. Delete + recreate for now.
            title={isEdit ? 'Amount can\'t be edited inline yet — delete and recreate to change.' : undefined}
            className={`${inputClass} text-right tabular-nums ${isEdit ? 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500' : ''}`}
            placeholder="0.00"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Bank account</label>
          <select
            name="bankAccountId"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="">— Select —</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber ? `${a.accountNumber} · ` : ''}{a.accountName}
              </option>
            ))}
          </select>
          {bankAccounts.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No bank accounts found. Add one to your Chart of Accounts (accountType=bank) first.
            </p>
          )}
        </div>
        {mode === 'single' && (
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Category</label>
            <CategorySelect
              namePrefix=""
              value={category}
              onChange={setCategory}
              accountGroups={accountGroups}
              outstandingBills={outstandingBills}
              outstandingInvoices={outstandingInvoices}
              required
            />
            {perBeneficiarySet.has(category.categoryAccountId) && beneficiaries && beneficiaries.length > 0 && (
              <BeneficiaryPicker
                value={beneficiaryId}
                onChange={setBeneficiaryId}
                beneficiaries={beneficiaries}
                requiresQualifying={foodOrClothingSet.has(category.categoryAccountId)}
              />
            )}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className={labelClass}>{type === 'deposit' ? 'Customer (optional)' : 'Vendor (optional)'}</label>
          <select
            name="contactId"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className={inputClass}
          >
            <option value="">— None —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className={`flex flex-col gap-1 ${mode === 'single' ? '' : 'sm:col-span-1'}`}>
          <label className={labelClass}>Description</label>
          <input
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
            placeholder="What this transaction was for"
          />
        </div>
      </div>

      {mode === 'split' && (
        <section className="rounded-lg border border-violet-200 bg-violet-50/30 p-4 dark:border-violet-900/60 dark:bg-violet-950/20">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
              Split lines
            </h3>
            <span className={`text-xs tabular-nums ${balanced ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {amountNum > 0
                ? balanced
                  ? `Balanced · in ${fmt(inflow)} − out ${fmt(outflow)} = ${type === 'deposit' ? '+' : '−'}${fmt(amountNum)} net`
                  : `In ${fmt(inflow)} · Out ${fmt(outflow)} · Net ${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))} (need ${signedAmount >= 0 ? '+' : '−'}${fmt(Math.abs(signedAmount))}, off by ${balanceDelta >= 0 ? '+' : '−'}${fmt(Math.abs(balanceDelta))})`
                : 'Enter an amount above to balance against'}
            </span>
          </header>

          <div className="flex flex-col gap-3">
            {lines.map((l, idx) => (
              <SplitLineRowEditor
                key={l.id}
                line={l}
                idx={idx}
                canRemove={lines.length > 2}
                accountGroups={accountGroups}
                contacts={contacts}
                outstandingBills={outstandingBills}
                outstandingInvoices={outstandingInvoices}
                onChange={(patch) => updateLine(l.id, patch)}
                onRemove={() => removeLine(l.id)}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={addLine}
            className="mt-2 rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            + Add line
          </button>
        </section>
      )}

      <input type="hidden" name="billingProductId" value={state?.unlockProductId ?? ''} />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending || bankAccounts.length === 0 || (mode === 'split' && !balanced)}
          title={mode === 'split' && !balanced ? 'Split lines must sum to the amount' : undefined}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Saving…' : isEdit ? `Update ${mode === 'split' ? 'split ' : ''}${type}` : `Save ${mode === 'split' ? 'split ' : ''}${type}`}
        </button>
        {isEdit && mode === 'split' && actions?.unsplitAction && initial && initial.splits.length > 0 && (
          <button
            type="submit"
            formAction={unsplitAction}
            disabled={unsplitPending}
            onClick={(e) => {
              if (!confirm('Remove the split and collapse to the first category? Re-categorize afterward.')) {
                e.preventDefault();
              }
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {unsplitPending ? 'Removing…' : 'Remove split'}
          </button>
        )}
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
        {unsplitState?.error && <span className="text-sm text-red-600">{unsplitState.error}</span>}
        {state?.unlockProductId && state.unlockLabel && (
          <button
            type="submit"
            formAction={startUnlockCheckoutAction}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
          >
            {state.unlockLabel}
          </button>
        )}
      </div>
    </form>
  );
}

interface SplitLineRowEditorProps {
  line: SplitLineRow;
  idx: number;
  canRemove: boolean;
  accountGroups: Array<{ label: string; accounts: Account[] }>;
  contacts: Contact[];
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  onChange: (patch: Partial<SplitLineRow>) => void;
  onRemove: () => void;
}

function SplitLineRowEditor({
  line,
  idx,
  canRemove,
  accountGroups,
  contacts,
  outstandingBills,
  outstandingInvoices,
  onChange,
  onRemove,
}: SplitLineRowEditorProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the "..." popover on outside click — matches the edit-screen
  // split form behavior.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="rounded-md border border-violet-200 bg-white p-3 dark:border-violet-900/40 dark:bg-zinc-950">
      {/* lines[i].type is sent as a hidden input — the visible control is the pill toggle. */}
      <input type="hidden" name={`lines[${idx}].type`} value={line.type} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr_140px_auto_auto] sm:items-end">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Type</label>
          <div className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            {(['deposit', 'withdrawal'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onChange({ type: t })}
                className={`rounded px-2 py-1 transition-colors ${
                  line.type === t
                    ? t === 'deposit'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-amber-600 text-white'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                }`}
              >
                {t === 'deposit' ? 'Dep' : 'Wd'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Category</label>
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
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Amount</label>
          <input
            name={`lines[${idx}].amount`}
            type="number"
            step="0.01"
            min="0.01"
            value={line.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            required
            className={`${inputClass} text-right tabular-nums`}
            placeholder="0.00"
          />
        </div>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More options"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
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
          className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:text-red-600 disabled:opacity-30"
        >
          ×
        </button>
      </div>

      {line.contactShown && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label className={labelClass}>{line.type === 'deposit' ? 'Customer' : 'Vendor'}</label>
            <select
              name={`lines[${idx}].contactId`}
              value={line.contactId}
              onChange={(e) => onChange({ contactId: e.target.value })}
              className={inputClass}
            >
              <option value="">— Select —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => onChange({ contactShown: false, contactId: '' })}
            aria-label="Remove contact field"
            className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:text-red-600"
          >
            ×
          </button>
        </div>
      )}

      {line.memoShown && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label className={labelClass}>Memo</label>
            <input
              name={`lines[${idx}].memo`}
              value={line.memo}
              onChange={(e) => onChange({ memo: e.target.value })}
              placeholder="Line memo"
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={() => onChange({ memoShown: false, memo: '' })}
            aria-label="Remove memo field"
            className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:text-red-600"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}


/**
 * Phase 4d beneficiary picker. Renders only when the picked category is a
 * per-beneficiary account on a trust org. Required by both the HTML form
 * (the underlying <select required>) and by the server-side categorize
 * action — defense in depth. For 815/820 accounts, non-qualifying
 * beneficiaries are disabled in the dropdown.
 */
function BeneficiaryPicker({
  value,
  onChange,
  beneficiaries,
  requiresQualifying,
}: {
  value: string;
  onChange: (v: string) => void;
  beneficiaries: readonly BeneficiaryOption[];
  requiresQualifying: boolean;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30">
      <label className="text-xs font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
        Beneficiary {requiresQualifying ? '(must be under 21 or incapacitated)' : '(required for this account)'}
      </label>
      <select
        name="beneficiaryId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">— Select beneficiary —</option>
        {beneficiaries.map((b) => {
          const disable = requiresQualifying && !b.qualifies;
          return (
            <option key={b.id} value={b.id} disabled={disable}>
              {b.fullName} · {b.ageNote}
              {disable ? " · doesn't qualify" : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}
