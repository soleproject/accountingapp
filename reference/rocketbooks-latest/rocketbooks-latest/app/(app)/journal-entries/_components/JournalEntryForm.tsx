'use client';

import { useActionState, useMemo, useState } from 'react';
import { createJournalEntryAction, type CreateJEState } from '../_actions/createJournalEntry';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}
interface Contact {
  id: string;
  name: string;
}
interface Line {
  id: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  contactId: string;
}

let nextId = 0;
const newLine = (): Line => ({ id: ++nextId, accountId: '', debit: '', credit: '', memo: '', contactId: '' });

export function JournalEntryForm({ accounts, contacts }: { accounts: Account[]; contacts: Contact[] }) {
  const [state, action, pending] = useActionState<CreateJEState | undefined, FormData>(createJournalEntryAction, undefined);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(), newLine()]);

  const totalDebit = useMemo(() => lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), [lines]);
  const totalCredit = useMemo(() => lines.reduce((s, l) => s + (Number(l.credit) || 0), 0), [lines]);
  const balanced = Math.round(totalDebit * 100) === Math.round(totalCredit * 100) && totalDebit > 0;

  const update = (id: number, patch: Partial<Line>) => setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const remove = (id: number) => setLines((cur) => (cur.length > 2 ? cur.filter((l) => l.id !== id) : cur));

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Date</label>
          <input
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</label>
          <input
            name="memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Optional"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" name="isAdjusting" className="h-4 w-4" />
        <span>Adjusting entry</span>
        <span className="text-xs text-zinc-500">— year-end accrual, depreciation, or reclass; shown in the Adjustments column of the trial balance.</span>
      </label>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <Th>Account</Th>
              <Th>Contact</Th>
              <Th align="right">Debit</Th>
              <Th align="right">Credit</Th>
              <Th>Memo</Th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={line.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="p-2">
                  <select
                    name={`lines[${idx}].accountId`}
                    value={line.accountId}
                    onChange={(e) => update(line.id, { accountId: e.target.value })}
                    required
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <option value="">— Select —</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountNumber} · {a.accountName}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <select
                    name={`lines[${idx}].contactId`}
                    value={line.contactId}
                    onChange={(e) => update(line.id, { contactId: e.target.value })}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <option value="">—</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    name={`lines[${idx}].debit`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.debit}
                    onChange={(e) => update(line.id, { debit: e.target.value, credit: e.target.value ? '' : line.credit })}
                    placeholder="0.00"
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </td>
                <td className="p-2">
                  <input
                    name={`lines[${idx}].credit`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.credit}
                    onChange={(e) => update(line.id, { credit: e.target.value, debit: e.target.value ? '' : line.debit })}
                    placeholder="0.00"
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </td>
                <td className="p-2">
                  <input
                    name={`lines[${idx}].memo`}
                    value={line.memo}
                    onChange={(e) => update(line.id, { memo: e.target.value })}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </td>
                <td className="p-2">
                  <button
                    type="button"
                    onClick={() => remove(line.id)}
                    disabled={lines.length <= 2}
                    className="text-zinc-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Remove line"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-t border-zinc-200 dark:border-zinc-800">
              <td colSpan={2} className="p-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                Totals
              </td>
              <td className="p-2 text-right tabular-nums">${totalDebit.toFixed(2)}</td>
              <td className="p-2 text-right tabular-nums">${totalCredit.toFixed(2)}</td>
              <td colSpan={2} className="p-2">
                <span className={balanced ? 'text-emerald-600' : 'text-amber-600'}>
                  {balanced ? '✓ Balanced' : `Diff: $${Math.abs(totalDebit - totalCredit).toFixed(2)}`}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setLines((cur) => [...cur, newLine()])}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          + Add line
        </button>
        <button
          type="submit"
          disabled={pending || !balanced}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Posting…' : 'Post entry'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 ${align === 'right' ? 'text-right' : ''}`}>
      {children}
    </th>
  );
}
