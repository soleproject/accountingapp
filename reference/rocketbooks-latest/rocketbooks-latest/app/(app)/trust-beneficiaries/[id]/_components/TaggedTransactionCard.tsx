'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { updateLineBeneficiary } from '../_actions/updateLineBeneficiary';
import { updateTransactionContact } from '../_actions/updateTransactionContact';

interface ContactOption {
  id: string;
  name: string;
}

export interface BeneficiaryOption {
  id: string;
  fullName: string;
  qualifies: boolean;
  ageNote: string;
}

export interface TaggedTransactionCardData {
  transactionId: string | null;
  journalEntryId: string;
  lineId: string;
  date: string;
  amount: number;
  side: 'debit' | 'credit';
  /** Category-side account (the trust account this beneficiary is tagged on). */
  accountNumber: string | null;
  accountName: string;
  /** Bank-side account label, derived from the JE's other line. */
  bankAccountLabel: string | null;
  vendorContactId: string | null;
  vendorName: string | null;
  bankDescription: string | null;
  memo: string | null;
  description: string | null;
  beneficiaryId: string | null;
  /** True iff the line's account requires a qualifying beneficiary (815/820). */
  requiresQualifying: boolean;
}

interface Props {
  data: TaggedTransactionCardData;
  contacts: ContactOption[];
  beneficiaries: BeneficiaryOption[];
}

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const inputCls =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const labelCls = 'text-xs font-medium uppercase tracking-wide text-zinc-500';
const readonlyCls =
  'rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300';

/**
 * One card in the per-transaction view of a beneficiary's tagged lines.
 * Mirrors the ManualTransactionForm visual layout: 2-column grid with
 * DATE | AMOUNT, BANK ACCOUNT | CATEGORY (+ BENEFICIARY highlight),
 * VENDOR | DESCRIPTION. Read-only fields (date/amount/bank/category/
 * description) are styled to match the disabled form inputs; the
 * VENDOR and BENEFICIARY selects autosave on change.
 */
export function TaggedTransactionRow({ data, contacts, beneficiaries }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string>(data.vendorContactId ?? '');
  const [bene, setBene] = useState<string>(data.beneficiaryId ?? '');

  const onVendorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!data.transactionId) return;
    const next = e.target.value || null;
    const prev = vendor;
    setVendor(next ?? '');
    setError(null);
    startTransition(async () => {
      const r = await updateTransactionContact({
        transactionId: data.transactionId!,
        contactId: next,
      });
      if (!r.ok) {
        setError(r.error ?? 'Failed to update vendor');
        setVendor(prev);
      }
    });
  };

  const onBeneChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value || null;
    const prev = bene;
    setBene(next ?? '');
    setError(null);
    startTransition(async () => {
      const r = await updateLineBeneficiary({
        lineId: data.lineId,
        beneficiaryId: next,
      });
      if (!r.ok) {
        setError(r.error ?? 'Failed to update beneficiary');
        setBene(prev);
      }
    });
  };

  const categoryLabel = data.accountNumber
    ? `${data.accountNumber} · ${data.accountName}`
    : data.accountName;
  const descriptor = data.bankDescription || data.memo || '';
  const openHref = data.transactionId
    ? `/transactions/${data.transactionId}`
    : `/journal-entries/${data.journalEntryId}`;
  const txnType = data.side === 'debit' ? 'withdrawal' : 'deposit';

  return (
    <div className="rounded-xl border border-zinc-400 bg-white p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-blue-500/60 hover:ring-2 hover:ring-blue-500/70 dark:border-zinc-500 dark:bg-zinc-800 dark:shadow-black/60 dark:ring-white/10 dark:hover:shadow-blue-400/60 dark:hover:ring-blue-400/60">
      {/* Header row mirrors the transaction detail page header: title +
          metadata strip on the left, amount on the right. */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {descriptor || 'Transaction'}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {data.date} · {txnType}
            {data.transactionId && (
              <>
                {' · '}
                <Link
                  href={`/journal-entries/${data.journalEntryId}`}
                  className="underline"
                >
                  View JE
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right text-xl font-semibold tabular-nums">
          {CURRENCY_FMT.format(data.amount)}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Date">
          <input type="date" value={data.date} disabled className={`${inputCls} disabled:opacity-100`} />
        </Field>
        <Field label="Amount">
          <input
            type="text"
            value={data.amount.toFixed(2)}
            disabled
            className={`${readonlyCls} text-right tabular-nums`}
          />
        </Field>

        <Field label="Bank account">
          <div className={readonlyCls}>{data.bankAccountLabel ?? '—'}</div>
        </Field>
        <div className="flex flex-col gap-2">
          <Field label="Category">
            <div className={readonlyCls}>{categoryLabel}</div>
          </Field>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-900/20">
            <Field label="Beneficiary (required for this account)">
              <select
                value={bene}
                onChange={onBeneChange}
                disabled={pending}
                className={`${inputCls} w-full disabled:opacity-50`}
              >
                <option value="">— untag —</option>
                {beneficiaries.map((b) => {
                  const disable = data.requiresQualifying && !b.qualifies;
                  return (
                    <option key={b.id} value={b.id} disabled={disable}>
                      {b.fullName} · {b.ageNote}
                      {disable ? " · doesn't qualify" : ''}
                    </option>
                  );
                })}
              </select>
            </Field>
          </div>
        </div>

        <Field label="Vendor (optional)">
          {data.transactionId ? (
            <select
              value={vendor}
              onChange={onVendorChange}
              disabled={pending}
              className={`${inputCls} w-full disabled:opacity-50`}
            >
              <option value="">— none —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <div className={readonlyCls}>
              {data.vendorName ?? '—'}{' '}
              <span className="text-xs text-zinc-500">(manual JE)</span>
            </div>
          )}
        </Field>
        <Field label="Description">
          <div className={`${readonlyCls} ${data.description ? '' : 'text-zinc-400'}`}>
            {data.description || 'What this transaction was for'}
          </div>
        </Field>
      </div>

      {error && (
        <div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}

      <div className="mt-4 flex items-center justify-end">
        <Link href={openHref} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Open full transaction →
        </Link>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}
