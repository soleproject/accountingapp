'use client';

import { useActionState, useState } from 'react';
import { createAccount, type CreateAccountState } from '../_actions/createAccount';

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

interface Props {
  potentialParents: { id: string; accountNumber: string; accountName: string }[];
}

export function AccountForm({ potentialParents }: Props) {
  const [state, action, pending] = useActionState<CreateAccountState | undefined, FormData>(createAccount, undefined);
  const [gaapType, setGaapType] = useState('current_asset');
  const inferredNormal = GAAP_TYPES.find((t) => t.value === gaapType)?.normal ?? 'debit';

  return (
    <form action={action} className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Number *</label>
          <input name="accountNumber" required placeholder="e.g. 1010" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Name *</label>
          <input name="accountName" required placeholder="e.g. Checking" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">GAAP type *</label>
          <select name="gaapType" required value={gaapType} onChange={(e) => setGaapType(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {GAAP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Normal balance *</label>
          <select name="normalBalance" required defaultValue={inferredNormal} key={inferredNormal} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Detail type</label>
          <input name="accountType" placeholder="Optional sub-classification" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Starting balance</label>
          <input name="startingBalance" type="number" step="0.01" defaultValue="0" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
          <span className="text-[11px] text-zinc-400">Posts an opening-balance entry to Opening Balance Equity. Leave 0 if none.</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">As of date</label>
          <input name="startingBalanceDate" type="date" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <span className="text-[11px] text-zinc-400">When the starting balance was true. Defaults to today.</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Parent account</label>
        <select name="parentAccountId" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="">— None (top level) —</option>
          {potentialParents.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Creating…' : 'Create account'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}
