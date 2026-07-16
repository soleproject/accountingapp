'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCustomerEmailAction } from '../_actions';
import type { OverdueCustomer } from '@/lib/enterprise/ar-collections';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Overdue customers we can't chase yet because their contact has no email.
 * Each row is fillable — add an address, save, and the customer moves into the
 * chaseable list above (the page refreshes from the server).
 */
export function MissingEmailList({ customers }: { customers: OverdueCustomer[] }) {
  if (customers.length === 0) return null;

  const totalCents = customers.reduce((s, c) => s + c.totalCents, 0);
  const invoiceCount = customers.reduce((s, c) => s + c.invoices.length, 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-950/20">
      <div>
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {invoiceCount} more overdue invoice{invoiceCount === 1 ? '' : 's'} ({money(totalCents)}) — missing a customer email
        </h2>
        <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
          These can&apos;t be chased until their customer has an email on file. Add one and they&apos;ll move up into the list to send.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {customers.map((c) => (
          <MissingEmailRow key={c.contactId} customer={c} />
        ))}
      </div>
    </section>
  );
}

function MissingEmailRow({ customer }: { customer: OverdueCustomer }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () => {
    setError(null);
    start(async () => {
      const res = await setCustomerEmailAction(customer.contactId, email);
      if (!res.ok) {
        setError(res.error ?? 'Could not save.');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-white px-3 py-2 dark:border-amber-900 dark:bg-zinc-950">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{customer.name}</div>
        <div className="text-xs text-zinc-500">
          {customer.invoices.length} invoice{customer.invoices.length === 1 ? '' : 's'} · {money(customer.totalCents)} past due
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && email.trim() && !pending) save();
          }}
          placeholder="customer@email.com"
          disabled={pending}
          className="w-56 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={save}
          disabled={pending || !email.trim()}
          className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save & include'}
        </button>
      </div>
      {error && <div className="w-full text-xs text-red-600">{error}</div>}
    </div>
  );
}
