'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface AccountOption {
  id: string;
  accountNumber: string | null;
  accountName: string;
}

interface AccountGroup<A extends AccountOption> {
  label: string;
  accounts: A[];
}

export interface BillOption {
  id: string;
  billNumber: string | null;
  vendorName: string | null;
  /** Vendor contact id — used by the surrounding form to auto-fill /
   *  lock the Contact field when a bill is selected. */
  contactId?: string | null;
  balance: number;
}

export interface InvoiceOption {
  id: string;
  invoiceNumber: string | null;
  customerName: string | null;
  /** Customer contact id — used by the surrounding form to auto-fill /
   *  lock the Contact field when an invoice is selected. */
  contactId?: string | null;
  balance: number;
}

/** Structured picker value — supports plain account picks and the
 *  directional intents (Payment Sent for a Bill, Payment Received for
 *  an Invoice). When intent is set, categoryAccountId is empty; the
 *  action resolves the AP/AR account at save. */
export interface CategoryPickerValue {
  categoryAccountId: string;
  intent: '' | 'bill_payment' | 'invoice_payment';
  intentTargetId: string;
}

interface Props<A extends AccountOption> {
  /** Field-name prefix — '' for top-level forms, 'lines[N].' for split rows. */
  namePrefix?: string;
  value: CategoryPickerValue;
  onChange: (next: CategoryPickerValue) => void;
  accountGroups: Array<AccountGroup<A>>;
  /** Outstanding bills in the org. If any have positive balance, the
   *  "Payment Sent for a Bill" directional is surfaced. */
  outstandingBills?: BillOption[];
  /** Outstanding invoices in the org. If any have positive balance, the
   *  "Payment Received for an Invoice" directional is surfaced. */
  outstandingInvoices?: InvoiceOption[];
  required?: boolean;
  placeholder?: string;
}

type View = 'root' | 'bills' | 'invoices';

const accountLabel = (a: AccountOption) =>
  a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName;

const billLabel = (b: BillOption) => {
  const num = b.billNumber ? `Bill #${b.billNumber}` : 'Bill';
  const vendor = b.vendorName ? ` | Payment to ${b.vendorName}` : '';
  return `${num}${vendor} | $${b.balance.toFixed(2)} Outstanding`;
};

const invoiceLabel = (i: InvoiceOption) => {
  const num = i.invoiceNumber ? `Invoice #${i.invoiceNumber}` : 'Invoice';
  const customer = i.customerName ? ` | Payment from ${i.customerName}` : '';
  return `${num}${customer} | $${i.balance.toFixed(2)} Outstanding`;
};

export function CategorySelect<A extends AccountOption>({
  namePrefix = '',
  value,
  onChange,
  accountGroups,
  outstandingBills = [],
  outstandingInvoices = [],
  required,
  placeholder = '— Select —',
}: Props<A>) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('root');
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Surface each directional only if there's at least one open
  // target. Paid bills / invoices carried in the list for label lookup
  // don't count.
  const showBillsDirectional = outstandingBills.some((b) => b.balance > 0);
  const showInvoicesDirectional = outstandingInvoices.some((i) => i.balance > 0);
  const showDirectionals = showBillsDirectional || showInvoicesDirectional;

  // Root view: filter accounts by query.
  const filteredAccountGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: Array<{ label: string; accounts: A[] }> = [];
    for (const g of accountGroups) {
      const accts = q
        ? g.accounts.filter((a) => {
            const num = (a.accountNumber ?? '').toLowerCase();
            const nm = a.accountName.toLowerCase();
            return num.includes(q) || nm.includes(q);
          })
        : g.accounts;
      if (accts.length) groups.push({ label: g.label, accounts: accts });
    }
    return groups;
  }, [accountGroups, query]);

  // Drill views only show open bills/invoices. The full lists are still
  // used below for label lookup on the trigger button so a fully-paid
  // bill / invoice keeps rendering its label.
  const filteredBills = useMemo(() => {
    const open = outstandingBills.filter((b) => b.balance > 0);
    const q = query.trim().toLowerCase();
    if (!q) return open;
    return open.filter((b) => {
      return (
        (b.billNumber ?? '').toLowerCase().includes(q) ||
        (b.vendorName ?? '').toLowerCase().includes(q)
      );
    });
  }, [outstandingBills, query]);

  const filteredInvoices = useMemo(() => {
    const open = outstandingInvoices.filter((i) => i.balance > 0);
    const q = query.trim().toLowerCase();
    if (!q) return open;
    return open.filter((i) => {
      return (
        (i.invoiceNumber ?? '').toLowerCase().includes(q) ||
        (i.customerName ?? '').toLowerCase().includes(q)
      );
    });
  }, [outstandingInvoices, query]);

  // Directionals filtered by query.
  const directionalsMatched = useMemo(() => {
    const all: Array<{ key: 'bills' | 'invoices'; label: string }> = [];
    if (showBillsDirectional) all.push({ key: 'bills', label: 'Payment Sent for a Bill' });
    if (showInvoicesDirectional) all.push({ key: 'invoices', label: 'Payment Received for an Invoice' });
    if (!showDirectionals) return [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((d) => d.label.toLowerCase().includes(q));
  }, [showBillsDirectional, showInvoicesDirectional, showDirectionals, query]);

  // Flat list for keyboard nav — depends on view.
  const flat = useMemo(() => {
    if (view === 'bills') {
      return filteredBills.map((b) => ({ kind: 'bill' as const, id: b.id }));
    }
    if (view === 'invoices') {
      return filteredInvoices.map((i) => ({ kind: 'invoice' as const, id: i.id }));
    }
    const items: Array<
      | { kind: 'directional'; key: 'bills' | 'invoices' }
      | { kind: 'account'; id: string }
    > = [];
    for (const d of directionalsMatched) items.push({ kind: 'directional', key: d.key });
    for (const g of filteredAccountGroups) {
      for (const a of g.accounts) items.push({ kind: 'account', id: a.id });
    }
    return items;
  }, [view, filteredBills, filteredInvoices, directionalsMatched, filteredAccountGroups]);

  useEffect(() => {
    if (focusIdx >= flat.length) setFocusIdx(0);
  }, [flat.length, focusIdx]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setView('root');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, view]);

  // Selected display in the trigger.
  const selectedLabel = useMemo(() => {
    if (value.intent === 'bill_payment' && value.intentTargetId) {
      const b = outstandingBills.find((b) => b.id === value.intentTargetId);
      return b ? billLabel(b) : `Bill payment`;
    }
    if (value.intent === 'invoice_payment' && value.intentTargetId) {
      const i = outstandingInvoices.find((i) => i.id === value.intentTargetId);
      return i ? invoiceLabel(i) : `Invoice payment`;
    }
    if (value.categoryAccountId) {
      for (const g of accountGroups) {
        const hit = g.accounts.find((a) => a.id === value.categoryAccountId);
        if (hit) return accountLabel(hit);
      }
    }
    return null;
  }, [value, accountGroups, outstandingBills, outstandingInvoices]);

  const pickAccount = (id: string) => {
    onChange({ categoryAccountId: id, intent: '', intentTargetId: '' });
    closePopup();
  };
  const pickBill = (id: string) => {
    onChange({ categoryAccountId: '', intent: 'bill_payment', intentTargetId: id });
    closePopup();
  };
  const pickInvoice = (id: string) => {
    onChange({ categoryAccountId: '', intent: 'invoice_payment', intentTargetId: id });
    closePopup();
  };
  const closePopup = () => {
    setOpen(false);
    setQuery('');
    setView('root');
    setFocusIdx(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = flat[focusIdx];
      if (!hit) return;
      if (hit.kind === 'directional') {
        setView(hit.key);
        setQuery('');
        setFocusIdx(0);
      } else if (hit.kind === 'account') {
        pickAccount(hit.id);
      } else if (hit.kind === 'bill') {
        pickBill(hit.id);
      } else if (hit.kind === 'invoice') {
        pickInvoice(hit.id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (view !== 'root') {
        setView('root');
        setQuery('');
        setFocusIdx(0);
      } else {
        closePopup();
      }
    }
  };

  // Required-ness: only enforce the legacy categoryAccountId field when
  // there's no intent. Otherwise we'd block bill/invoice picks.
  const accountFieldRequired = required && !value.intent;

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        type="hidden"
        name={`${namePrefix}categoryAccountId`}
        value={value.categoryAccountId}
        required={accountFieldRequired}
      />
      <input type="hidden" name={`${namePrefix}intent`} value={value.intent} />
      <input type="hidden" name={`${namePrefix}intentTargetId`} value={value.intentTargetId} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-left text-sm dark:border-zinc-700 dark:bg-zinc-900"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selectedLabel ? '' : 'text-zinc-400'}>
          {selectedLabel ?? placeholder}
        </span>
        <span aria-hidden className="text-xs text-zinc-400">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-96 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFocusIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={
                view === 'bills'
                  ? 'Search bills…'
                  : view === 'invoices'
                    ? 'Search invoices…'
                    : 'Search categories…'
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          <div className="max-h-80 overflow-y-auto py-1">
            {view === 'root' && (
              <>
                {directionalsMatched.map((d) => {
                  const flatIdx = flat.findIndex((f) => f.kind === 'directional' && f.key === d.key);
                  const isFocused = flatIdx === focusIdx;
                  return (
                    <button
                      type="button"
                      key={d.key}
                      onMouseEnter={() => setFocusIdx(flatIdx)}
                      onClick={() => {
                        setView(d.key);
                        setQuery('');
                        setFocusIdx(0);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        isFocused ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                      }`}
                    >
                      <span>{d.label}</span>
                      <span aria-hidden className="text-zinc-400">›</span>
                    </button>
                  );
                })}
                {directionalsMatched.length > 0 && filteredAccountGroups.length > 0 && (
                  <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                )}
                {filteredAccountGroups.length === 0 && directionalsMatched.length === 0 && (
                  <div className="px-3 py-2 text-sm text-zinc-500">No matches</div>
                )}
                {filteredAccountGroups.map((g) => (
                  <div key={g.label}>
                    <div className="mx-2 mb-1 mt-2 border-b border-zinc-200 px-1 pb-1 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                      {g.label}
                    </div>
                    {g.accounts.map((a) => {
                      const flatIdx = flat.findIndex((f) => f.kind === 'account' && f.id === a.id);
                      const isFocused = flatIdx === focusIdx;
                      const isSelected = a.id === value.categoryAccountId && !value.intent;
                      return (
                        <button
                          type="button"
                          key={a.id}
                          onMouseEnter={() => setFocusIdx(flatIdx)}
                          onClick={() => pickAccount(a.id)}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                            isFocused ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                          } ${isSelected ? 'font-medium text-blue-700 dark:text-blue-300' : ''}`}
                        >
                          <span>{accountLabel(a)}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </>
            )}

            {view === 'bills' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setView('root');
                    setQuery('');
                    setFocusIdx(0);
                  }}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  <span aria-hidden>‹</span> More options
                </button>
                <div className="mx-2 mb-1 mt-2 border-b border-zinc-200 px-1 pb-1 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                  Outstanding Bills
                </div>
                {filteredBills.length === 0 && (
                  <div className="px-3 py-2 text-sm text-zinc-500">No outstanding bills</div>
                )}
                {filteredBills.map((b, idx) => {
                  const isFocused = idx === focusIdx;
                  const isSelected =
                    value.intent === 'bill_payment' && value.intentTargetId === b.id;
                  return (
                    <button
                      type="button"
                      key={b.id}
                      onMouseEnter={() => setFocusIdx(idx)}
                      onClick={() => pickBill(b.id)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        isFocused ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                      } ${isSelected ? 'font-medium text-blue-700 dark:text-blue-300' : ''}`}
                    >
                      <span>{billLabel(b)}</span>
                    </button>
                  );
                })}
              </>
            )}

            {view === 'invoices' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setView('root');
                    setQuery('');
                    setFocusIdx(0);
                  }}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  <span aria-hidden>‹</span> More options
                </button>
                <div className="mx-2 mb-1 mt-2 border-b border-zinc-200 px-1 pb-1 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                  Outstanding Invoices
                </div>
                {filteredInvoices.length === 0 && (
                  <div className="px-3 py-2 text-sm text-zinc-500">No outstanding invoices</div>
                )}
                {filteredInvoices.map((inv, idx) => {
                  const isFocused = idx === focusIdx;
                  const isSelected =
                    value.intent === 'invoice_payment' && value.intentTargetId === inv.id;
                  return (
                    <button
                      type="button"
                      key={inv.id}
                      onMouseEnter={() => setFocusIdx(idx)}
                      onClick={() => pickInvoice(inv.id)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        isFocused ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                      } ${isSelected ? 'font-medium text-blue-700 dark:text-blue-300' : ''}`}
                    >
                      <span>{invoiceLabel(inv)}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
