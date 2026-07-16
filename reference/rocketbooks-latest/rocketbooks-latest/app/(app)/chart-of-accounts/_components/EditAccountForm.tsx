'use client';

import { useActionState, useState } from 'react';
import { updateAccount, type UpdateAccountState } from '../_actions/updateAccount';

const GAAP_TYPES = [
  { value: 'current_asset', label: 'Current asset', normal: 'debit' },
  { value: 'fixed_asset', label: 'Fixed asset', normal: 'debit' },
  { value: 'other_asset', label: 'Other asset', normal: 'debit' },
  { value: 'asset', label: 'Asset (generic)', normal: 'debit' },
  { value: 'current_liability', label: 'Current liability', normal: 'credit' },
  { value: 'long_term_liability', label: 'Long-term liability', normal: 'credit' },
  { value: 'other_liability', label: 'Other liability', normal: 'credit' },
  { value: 'liability', label: 'Liability (generic)', normal: 'credit' },
  { value: 'equity', label: 'Equity', normal: 'credit' },
  { value: 'revenue', label: 'Revenue', normal: 'credit' },
  { value: 'income', label: 'Income', normal: 'credit' },
  { value: 'other_income', label: 'Other income', normal: 'credit' },
  { value: 'expense', label: 'Expense', normal: 'debit' },
  { value: 'cost_of_goods_sold', label: 'Cost of goods sold', normal: 'debit' },
  { value: 'other_expense', label: 'Other expense', normal: 'debit' },
];

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
  accountType: string | null;
  detailType: string | null;
  parentAccountId: string | null;
  normalBalance: string;
  isActive: boolean | null;
}

interface Props {
  account: Account;
  potentialParents: { id: string; accountNumber: string; accountName: string }[];
}

export function EditAccountForm({ account, potentialParents }: Props) {
  const [state, action, pending] = useActionState<UpdateAccountState | undefined, FormData>(updateAccount, undefined);
  const [gaapType, setGaapType] = useState(account.gaapType);

  return (
    <form action={action} className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <input type="hidden" name="id" value={account.id} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Number *</label>
          <input name="accountNumber" required defaultValue={account.accountNumber} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Name *</label>
          <input name="accountName" required defaultValue={account.accountName} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">GAAP type *</label>
          <select name="gaapType" required value={gaapType} onChange={(e) => setGaapType(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {GAAP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            {/* If the row's gaap_type isn't in the canonical list (legacy data),
                surface it as an option so we don't silently drop it on save. */}
            {!GAAP_TYPES.some((t) => t.value === account.gaapType) && (
              <option value={account.gaapType}>{account.gaapType} (current)</option>
            )}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Normal balance *</label>
          <select name="normalBalance" required defaultValue={account.normalBalance} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Account type</label>
          <input name="accountType" defaultValue={account.accountType ?? ''} placeholder="e.g. expenses" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Detail type</label>
          <input name="detailType" defaultValue={account.detailType ?? ''} placeholder="e.g. entertainment_meals" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Parent account</label>
        <select name="parentAccountId" defaultValue={account.parentAccountId ?? ''} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="">— None (top level) —</option>
          {potentialParents
            .filter((p) => p.id !== account.id)
            .map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={account.isActive !== false}
          className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>Active</span>
        <span className="text-xs text-zinc-500">— uncheck to hide from pickers and CoA listing without deleting</span>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <a href="/chart-of-accounts" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          Cancel
        </a>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}
