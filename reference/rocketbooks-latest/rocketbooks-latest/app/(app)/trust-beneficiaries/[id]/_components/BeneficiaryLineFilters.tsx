'use client';

import { useEffect, useState } from 'react';

interface AccountOption {
  id: string;
  accountNumber: string | null;
  accountName: string;
}

interface SelectedFilters {
  q: string;
  accountId: string;
  side: '' | 'debit' | 'credit';
  start: string;
  end: string;
}

interface Props {
  accounts: AccountOption[];
  selected: SelectedFilters;
}

const STORAGE_KEY = 'rs_trust_beneficiary_filters_open';

/**
 * Show/Hide filter panel above the tagged-lines table. Mirrors the
 * Trust Review filter UX (same colors, same persistence key pattern,
 * same submit-via-form-GET wiring).
 */
export function BeneficiaryLineFilters({ accounts, selected }: Props) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === '0') setOpen(false);
    } catch {
      // ignore
    }
  }, []);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  const hasAnyFilter =
    !!selected.q ||
    !!selected.accountId ||
    !!selected.side ||
    !!selected.start ||
    !!selected.end;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className={`rounded-md border px-3 py-1 text-sm font-medium transition-colors ${
            open
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
          }`}
          aria-expanded={open}
          // Edge / Office form-fill extensions stamp `fdprocessedid` onto
          // buttons after hydration; suppress that specific mismatch.
          suppressHydrationWarning
        >
          {open ? '▾ Hide Filters' : '▸ Show Filters'}
        </button>
        {!open && hasAnyFilter && (
          <>
            <a
              href="?"
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Clear
            </a>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              (active filters hidden)
            </span>
          </>
        )}
      </div>

      {open && (
        <form
          method="get"
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <input
            type="text"
            name="q"
            defaultValue={selected.q}
            placeholder="Search memo — vendor name, note text…"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Account">
              <select
                name="accountId"
                defaultValue={selected.accountId}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Side">
              <select
                name="side"
                defaultValue={selected.side}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">Both</option>
                <option value="debit">Debit only</option>
                <option value="credit">Credit only</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Start Date">
              <input
                type="date"
                name="start"
                defaultValue={selected.start}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </Field>
            <Field label="End Date">
              <input
                type="date"
                name="end"
                defaultValue={selected.end}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              Apply filters
            </button>
            {hasAnyFilter && (
              <a
                href="?"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Clear
              </a>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
    </label>
  );
}
