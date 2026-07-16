'use client';

import { useActionState, useState } from 'react';
import { createPayment, type CreatePaymentState } from '../_actions/createPayment';
import { startUnlockCheckoutAction } from '@/app/(app)/billing/_actions/billing';

interface Account { id: string; accountNumber: string; accountName: string; gaapType: string; }
interface Contact { id: string; name: string; }
interface InvoiceRef { id: string; number: string | null; date: string; }
interface BillRef { id: string; number: string | null; date: string; }

interface Props {
  contacts: Contact[];
  bankAccounts: Account[];
  arAccounts: Account[];
  apAccounts: Account[];
  invoices: InvoiceRef[];
  bills: BillRef[];
}

export function PaymentForm({ contacts, bankAccounts, arAccounts, apAccounts, invoices, bills }: Props) {
  const [state, action, pending] = useActionState<CreatePaymentState | undefined, FormData>(createPayment, undefined);
  const [type, setType] = useState<'received' | 'sent'>('received');
  const arApList = type === 'received' ? arAccounts : apAccounts;

  return (
    <form action={action} className="flex max-w-2xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-1 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <label className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded px-3 py-1.5 ${type === 'received' ? 'bg-white shadow dark:bg-zinc-950' : ''}`}>
          <input type="radio" name="type" value="received" checked={type === 'received'} onChange={() => setType('received')} className="sr-only" />
          Receive (from customer)
        </label>
        <label className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded px-3 py-1.5 ${type === 'sent' ? 'bg-white shadow dark:bg-zinc-950' : ''}`}>
          <input type="radio" name="type" value="sent" checked={type === 'sent'} onChange={() => setType('sent')} className="sr-only" />
          Send (to vendor)
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Date</label>
          <input name="paymentDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</label>
          <input name="amount" type="number" step="0.01" min="0.01" required className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">{type === 'received' ? 'Customer' : 'Vendor'}</label>
          <select name="contactId" required className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— Select —</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Bank account</label>
          <select name="bankAccountId" required className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— Select —</option>
            {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">{type === 'received' ? 'AR account' : 'AP account'}</label>
          <select name="arApAccountId" required className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">— Select —</option>
            {arApList.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}</option>)}
          </select>
        </div>
        {type === 'received' && (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Apply to invoice (optional)</label>
            <select name="invoiceId" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">— None —</option>
              {invoices.map((i) => <option key={i.id} value={i.id}>{i.date} · {i.number ?? `#${i.id.slice(0, 8)}`}</option>)}
            </select>
          </div>
        )}
        {type === 'sent' && (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Apply to bill (optional)</label>
            <select name="billId" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">— None —</option>
              {bills.map((b) => <option key={b.id} value={b.id}>{b.date} · {b.number ?? `#${b.id.slice(0, 8)}`}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Posting…' : 'Save & Post'}
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
