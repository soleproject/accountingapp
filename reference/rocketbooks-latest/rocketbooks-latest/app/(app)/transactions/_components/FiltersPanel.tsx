'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

interface AccountOption {
  id: string;
  accountNumber: string;
  accountName: string;
}

interface ContactOption {
  id: string;
  contactName: string;
}

interface SelectedFilters {
  q: string;
  accountId: string;
  categoryId: string;
  contactId: string;
  start: string;
  end: string;
}

interface PreserveParams {
  filter?: string;
  sort?: string;
  dir?: string;
  view?: string;
  details?: string;
  deposits?: string;
  withdrawals?: string;
  reviewed?: string;
  unreviewed?: string;
}

interface Props {
  bankAccounts?: AccountOption[];
  categoryAccounts?: AccountOption[];
  contacts?: ContactOption[];
  selected: SelectedFilters;
  preserve: PreserveParams;
  /** When true the Account + JE columns are shown; the toggle flips ?details. */
  showDetails: boolean;
  /** Type filters — both default on; toggles flip ?deposits / ?withdrawals. */
  showDeposits: boolean;
  showWithdrawals: boolean;
  /** Review-status filters — both default on; toggles flip ?reviewed / ?unreviewed. */
  showReviewed: boolean;
  showUnreviewed: boolean;
  /** Extra controls rendered inline with the Show/Hide-filters toggle —
   *  e.g. the search form, filter pills, and Start guided review CTA. */
  children?: React.ReactNode;
}

const STORAGE_KEY = 'rs_txn_filters_open';

/**
 * Filter panel above the transactions table. One <form method="get"> with all
 * the inputs — submit reloads the page with the picked filters in the URL.
 *
 * "Hide filters" toggle is client-side state persisted in localStorage so the
 * user's preference sticks across navigations. Defaults to expanded.
 */
export function FiltersPanel({
  bankAccounts = [],
  categoryAccounts = [],
  contacts = [],
  selected,
  preserve,
  showDetails,
  showDeposits,
  showWithdrawals,
  showReviewed,
  showUnreviewed,
  children,
}: Props) {
  const [open, setOpen] = useState(true);
  const [bankAccountOptions, setBankAccountOptions] = useState<AccountOption[]>(bankAccounts);
  const [categoryAccountOptions, setCategoryAccountOptions] = useState<AccountOption[]>(categoryAccounts);
  const [accountOptionsLoaded, setAccountOptionsLoaded] = useState(bankAccounts.length > 0 || categoryAccounts.length > 0);
  const [contactOptions, setContactOptions] = useState<ContactOption[]>(contacts);
  const [contactQuery, setContactQuery] = useState('');
  // Hydrate from localStorage on mount (avoids SSR/CSR mismatch by deferring
  // the read until after first render).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === '0') setOpen(false);
    } catch {
      // ignore
    }
  }, []);

  const loadAccountOptions = async () => {
    if (accountOptionsLoaded) return;
    const params = new URLSearchParams({ kind: 'accounts' });
    try {
      const res = await fetch(`/api/transactions/filter-options?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { bankAccounts?: AccountOption[]; categoryAccounts?: AccountOption[] };
      if (Array.isArray(data.bankAccounts)) setBankAccountOptions(data.bankAccounts);
      if (Array.isArray(data.categoryAccounts)) setCategoryAccountOptions(data.categoryAccounts);
      setAccountOptionsLoaded(true);
    } catch {
      // keep filters usable; the next focus can retry
    }
  };

  const loadContactOptions = async (query = contactQuery) => {
    const params = new URLSearchParams({ kind: 'contacts' });
    if (query.trim()) params.set('q', query.trim());
    try {
      const res = await fetch(`/api/transactions/filter-options?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { contacts?: ContactOption[] };
      if (Array.isArray(data.contacts)) setContactOptions(data.contacts);
    } catch {
      // keep filters usable; the next focus/search can retry
    }
  };
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
    !!selected.categoryId ||
    !!selected.contactId ||
    !!selected.start ||
    !!selected.end;

  // "Show All" turns every status/type toggle on (and drops any explicit filter
  // / guided-review state) so the table shows everything.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const showAllHref = (() => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('reviewed', '1');
    next.set('unreviewed', '1');
    next.set('deposits', '1');
    next.set('withdrawals', '1');
    next.delete('filter');
    next.delete('guide');
    next.delete('guideIndex');
    next.delete('page');
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  })();
  const rememberShowAll = () => {
    try {
      for (const k of ['rs_txn_reviewed', 'rs_txn_unreviewed', 'rs_txn_deposits', 'rs_txn_withdrawals']) {
        document.cookie = `${k}=1; path=/; max-age=31536000; samesite=lax`;
      }
    } catch {
      // ignore
    }
  };

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
        >
          {open ? '▾ Hide Filters' : '▸ Show Filters'}
        </button>
        <Link
          href={showAllHref}
          prefetch={false}
          onClick={rememberShowAll}
          className="rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Show All
        </Link>
        {!open && hasAnyFilter && (
          <>
            <a
              href={buildResetHref(preserve)}
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Clear
            </a>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">(active filters hidden)</span>
          </>
        )}
        {children && (
          <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
        )}
      </div>

      {open && (
        <form
          method="get"
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          {/* Hidden params we want to preserve across filter submits */}
          {preserve.filter && <input type="hidden" name="filter" value={preserve.filter} />}
          {preserve.sort && <input type="hidden" name="sort" value={preserve.sort} />}
          {preserve.dir && <input type="hidden" name="dir" value={preserve.dir} />}
          {preserve.view && <input type="hidden" name="view" value={preserve.view} />}
          {preserve.details && <input type="hidden" name="details" value={preserve.details} />}
          {preserve.deposits && <input type="hidden" name="deposits" value={preserve.deposits} />}
          {preserve.withdrawals && <input type="hidden" name="withdrawals" value={preserve.withdrawals} />}
          {preserve.reviewed && <input type="hidden" name="reviewed" value={preserve.reviewed} />}
          {preserve.unreviewed && <input type="hidden" name="unreviewed" value={preserve.unreviewed} />}

          <div className="flex flex-col gap-2">
            <TxnToggle
              label="Categorized"
              description="Show categorized transactions"
              on={showReviewed}
              paramKey="reviewed"
              cookieKey="rs_txn_reviewed"
            />
            <TxnToggle
              label="Uncategorized"
              description="Show transactions still needing categorization"
              on={showUnreviewed}
              paramKey="unreviewed"
              cookieKey="rs_txn_unreviewed"
            />
            <TxnToggle
              label="Deposit Transactions"
              description="Show money-in (deposits)"
              on={showDeposits}
              paramKey="deposits"
              cookieKey="rs_txn_deposits"
            />
            <TxnToggle
              label="Withdrawal Transactions"
              description="Show money-out (withdrawals)"
              on={showWithdrawals}
              paramKey="withdrawals"
              cookieKey="rs_txn_withdrawals"
            />
            <TxnToggle
              label="Transaction Details"
              description="Show the Account and JE columns"
              on={showDetails}
              paramKey="details"
              cookieKey="rs_txn_details"
            />
          </div>

          <input
            type="text"
            name="q"
            defaultValue={selected.q}
            placeholder="Search transactions…"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Accounts">
              <select
                name="accountId"
                defaultValue={selected.accountId}
                onFocus={loadAccountOptions}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">All Accounts</option>
                {selected.accountId && !bankAccountOptions.some((a) => a.id === selected.accountId) && (
                  <option value={selected.accountId}>Selected account</option>
                )}
                {bankAccountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber} · {a.accountName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Categories">
              <select
                name="categoryId"
                defaultValue={selected.categoryId}
                onFocus={loadAccountOptions}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">All Categories</option>
                {selected.categoryId && !categoryAccountOptions.some((a) => a.id === selected.categoryId) && (
                  <option value={selected.categoryId}>Selected category</option>
                )}
                {categoryAccountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber} · {a.accountName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contacts">
              <input
                type="search"
                value={contactQuery}
                onFocus={() => loadContactOptions()}
                onChange={(e) => {
                  const next = e.target.value;
                  setContactQuery(next);
                  void loadContactOptions(next);
                }}
                placeholder="Type to search contacts…"
                className="mb-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <select
                name="contactId"
                defaultValue={selected.contactId}
                onFocus={() => loadContactOptions()}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">All Contacts</option>
                {selected.contactId && !contactOptions.some((c) => c.id === selected.contactId) && (
                  <option value={selected.contactId}>Selected contact</option>
                )}
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contactName}
                  </option>
                ))}
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
            {/* "Reset" by linking back to the page WITHOUT any of the filter
                params. Preserves filter pill / sort / group via the hidden
                inputs above is intentionally NOT done here — Reset clears
                the filter form to a clean slate but keeps the URL on the
                same view (filter=). */}
            {hasAnyFilter && (
              <a
                href={buildResetHref(preserve)}
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

/**
 * A switch toggle (in the filter panel) that flips a URL param and persists the
 * choice in a cookie so it's remembered on the next fresh visit. The server
 * reads the cookie whenever the param is absent.
 */
function TxnToggle({
  label,
  description,
  on,
  paramKey,
  cookieKey,
}: {
  label: string;
  description: string;
  on: boolean;
  paramKey: string;
  cookieKey: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Explicit value so the toggle works even when the state came from the cookie
  // (no param in the URL yet).
  const href = (() => {
    const next = new URLSearchParams(searchParams.toString());
    next.set(paramKey, on ? '0' : '1');
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  })();
  const remember = () => {
    try {
      document.cookie = `${cookieKey}=${on ? '0' : '1'}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // ignore
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <Link
        href={href}
        prefetch={false}
        onClick={remember}
        role="switch"
        aria-checked={on}
        aria-label={`Toggle ${label}`}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700'}`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </Link>
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

function buildResetHref(preserve: PreserveParams): string {
  const parts: string[] = [];
  if (preserve.filter) parts.push(`filter=${encodeURIComponent(preserve.filter)}`);
  if (preserve.sort) parts.push(`sort=${encodeURIComponent(preserve.sort)}`);
  if (preserve.dir) parts.push(`dir=${encodeURIComponent(preserve.dir)}`);
  if (preserve.view) parts.push(`view=${encodeURIComponent(preserve.view)}`);
  if (preserve.details) parts.push(`details=${encodeURIComponent(preserve.details)}`);
  if (preserve.deposits) parts.push(`deposits=${encodeURIComponent(preserve.deposits)}`);
  if (preserve.withdrawals) parts.push(`withdrawals=${encodeURIComponent(preserve.withdrawals)}`);
  if (preserve.reviewed) parts.push(`reviewed=${encodeURIComponent(preserve.reviewed)}`);
  if (preserve.unreviewed) parts.push(`unreviewed=${encodeURIComponent(preserve.unreviewed)}`);
  return parts.length === 0 ? '?' : `?${parts.join('&')}`;
}
