'use client';

import { useActionState, useMemo, useState } from 'react';
import type { CreateInvoiceState } from '../_actions/createInvoice';
import { startUnlockCheckoutAction } from '@/app/(app)/billing/_actions/billing';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}
interface Contact { id: string; name: string; }
interface Line {
  id: number;
  description: string;
  quantity: string;
  unitPrice: string;
  revenueAccountId: string;
}

let nextId = 0;
const newLine = (): Line => ({ id: ++nextId, description: '', quantity: '1', unitPrice: '', revenueAccountId: '' });

export interface InvoiceFormInitial {
  contactId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  memo: string;
  arAccountId: string;
  postNow: boolean;
  discountAmount?: string;
  taxAmount?: string;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    revenueAccountId: string;
  }>;
}

interface Props {
  contacts: Contact[];
  revenueAccounts: Account[];
  arAccounts: Account[];
  /** Server action shaped like createInvoice. Used for both create and
   *  update flows — the update wrapper closes over the invoice id. */
  action: (
    prev: CreateInvoiceState | undefined,
    formData: FormData,
  ) => Promise<CreateInvoiceState | undefined>;
  /** When set, prefills the form for an edit. */
  initial?: InvoiceFormInitial;
  /** Submit-button label. Defaults match the create flow. */
  submitDraftLabel?: string;
  submitPostLabel?: string;
}

const seedLines = (initial?: InvoiceFormInitial): Line[] => {
  if (!initial || initial.lines.length === 0) return [newLine()];
  return initial.lines.map((l) => ({
    id: ++nextId,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    revenueAccountId: l.revenueAccountId,
  }));
};

export function InvoiceForm({
  contacts,
  revenueAccounts,
  arAccounts,
  action,
  initial,
  submitDraftLabel,
  submitPostLabel,
}: Props) {
  const [state, formAction, pending] = useActionState<CreateInvoiceState | undefined, FormData>(action, undefined);
  const [lines, setLines] = useState<Line[]>(() => seedLines(initial));
  const [postNow, setPostNow] = useState<boolean>(initial?.postNow ?? true);
  const [discount, setDiscount] = useState<string>(initial?.discountAmount ?? '');
  const [tax, setTax] = useState<string>(initial?.taxAmount ?? '');

  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines],
  );
  const discountNum = Number(discount) || 0;
  const taxNum = Number(tax) || 0;
  const total = subtotal - discountNum + taxNum;

  const update = (id: number, patch: Partial<Line>) =>
    setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const draftLabel = submitDraftLabel ?? 'Save Draft';
  const postLabel = submitPostLabel ?? 'Save & Post';

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Customer</label>
          <select name="contactId" required defaultValue={initial?.contactId ?? ''} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— Select —</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Invoice number</label>
          <input name="invoiceNumber" defaultValue={initial?.invoiceNumber ?? ''} placeholder="Optional" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">AR account</label>
          <select name="arAccountId" required defaultValue={initial?.arAccountId ?? ''} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— Select —</option>
            {arAccounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Invoice date</label>
          <input name="invoiceDate" type="date" required defaultValue={initial?.invoiceDate ?? new Date().toISOString().slice(0, 10)} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Due date</label>
          <input name="dueDate" type="date" defaultValue={initial?.dueDate ?? ''} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</label>
          <input name="memo" defaultValue={initial?.memo ?? ''} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">Revenue account</th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Qty</th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Price</th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const amount = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
              return (
                <tr key={line.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="p-2">
                    <input name={`lines[${idx}].description`} value={line.description} onChange={(e) => update(line.id, { description: e.target.value })} className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
                  </td>
                  <td className="p-2">
                    <select name={`lines[${idx}].revenueAccountId`} value={line.revenueAccountId} onChange={(e) => update(line.id, { revenueAccountId: e.target.value })} required className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                      <option value="">— Select —</option>
                      {revenueAccounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
                    </select>
                  </td>
                  <td className="p-2">
                    <input name={`lines[${idx}].quantity`} type="number" step="0.01" min="0" value={line.quantity} onChange={(e) => update(line.id, { quantity: e.target.value })} required className="w-24 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
                  </td>
                  <td className="p-2">
                    <input name={`lines[${idx}].unitPrice`} type="number" step="0.01" min="0" value={line.unitPrice} onChange={(e) => update(line.id, { unitPrice: e.target.value })} required className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
                  </td>
                  <td className="p-2 text-right tabular-nums">${amount.toFixed(2)}</td>
                  <td className="p-2 text-center">
                    <button type="button" onClick={() => setLines((cur) => (cur.length > 1 ? cur.filter((l) => l.id !== line.id) : cur))} disabled={lines.length <= 1} className="text-zinc-400 hover:text-red-600 disabled:opacity-30" aria-label="Remove">
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-t border-zinc-200 dark:border-zinc-800">
              <td colSpan={4} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Subtotal</td>
              <td className="px-3 py-2 text-right text-sm tabular-nums">${subtotal.toFixed(2)}</td>
              <td></td>
            </tr>
            <tr>
              <td colSpan={4} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Discount</td>
              <td className="px-3 py-2 text-right">
                <input
                  name="discountAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="0.00"
                  className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                />
              </td>
              <td></td>
            </tr>
            <tr>
              <td colSpan={4} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Tax</td>
              <td className="px-3 py-2 text-right">
                <input
                  name="taxAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                  placeholder="0.00"
                  className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                />
              </td>
              <td></td>
            </tr>
            <tr className="border-t border-zinc-200 dark:border-zinc-800">
              <td colSpan={4} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Total</td>
              <td className="px-3 py-2 text-right text-base font-semibold tabular-nums">${total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setLines((cur) => [...cur, newLine()])} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          + Add line
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="postNow" checked={postNow} onChange={(e) => setPostNow(e.target.checked)} value="true" />
          Post JE now (debit AR / credit revenue)
        </label>
        <button type="submit" disabled={pending || total <= 0} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Saving…' : postNow ? postLabel : draftLabel}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
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
      <input type="hidden" name="billingProductId" value={state?.unlockProductId ?? ''} />
    </form>
  );
}
