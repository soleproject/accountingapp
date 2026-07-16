'use client';

import { useMemo, useState } from 'react';
import { getAccountType, getDetail } from '@/lib/accounting/coa-taxonomy';

export interface AccountRow {
  id: string;
  parentAccountId: string | null;
  accountNumber: string;
  accountName: string;
  gaapType: string;
  accountType: string | null;
  detailType: string | null;
  normalBalance: string;
  isActive: boolean | null;
}

interface Props {
  allRows: AccountRow[];
  /** Whether the parent server component is including hidden rows already. */
  includesHidden: boolean;
  hiddenCount: number;
  /** Hrefs the parent server component computed for the toggle link. */
  toggleHiddenHref: string;
  toggleHiddenLabel: string;
}

// Balance sheet first, then P&L. Matches accountant convention.
const GAAP_ORDER: Array<{ key: string; label: string }> = [
  { key: 'asset',     label: 'Asset' },
  { key: 'liability', label: 'Liability' },
  { key: 'equity',    label: 'Equity' },
  { key: 'income',    label: 'Income' },
  { key: 'expense',   label: 'Expense' },
];

interface AccountNode extends AccountRow {
  children: AccountNode[];
}

function buildTree(rows: AccountRow[]): AccountNode[] {
  const byId = new Map<string, AccountNode>();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: AccountNode[] = [];
  byId.forEach((node) => {
    if (node.parentAccountId && byId.has(node.parentAccountId)) {
      byId.get(node.parentAccountId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function flattenTree(nodes: AccountNode[], depth = 0): Array<{ node: AccountNode; depth: number }> {
  const out: Array<{ node: AccountNode; depth: number }> = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    out.push(...flattenTree(n.children, depth + 1));
  }
  return out;
}

function accountTypeLabel(slug: string | null): string {
  if (!slug) return '—';
  return getAccountType(slug)?.label ?? slug;
}
function detailTypeLabel(accountTypeSlug: string | null, slug: string | null): string {
  if (!slug) return '—';
  if (accountTypeSlug) {
    const canonical = getDetail(accountTypeSlug, slug);
    if (canonical) return canonical.label;
  }
  return slug;
}

export function CoaBrowser({ allRows, includesHidden, hiddenCount, toggleHiddenHref, toggleHiddenLabel }: Props) {
  const [search, setSearch] = useState('');
  const [accountTypeFilter, setAccountTypeFilter] = useState('');
  const [balanceFilter, setBalanceFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Distinct accountType values present in the data, for the dropdown.
  const accountTypeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of allRows) {
      if (r.accountType && !seen.has(r.accountType)) {
        seen.set(r.accountType, accountTypeLabel(r.accountType));
      }
    }
    return Array.from(seen.entries())
      .map(([slug, label]) => ({ slug, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allRows]);

  // Filter rows by search + dropdowns. Search matches name, number, account
  // type label, and detail type label so the placeholder isn't lying.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (accountTypeFilter && r.accountType !== accountTypeFilter) return false;
      if (balanceFilter && r.normalBalance !== balanceFilter) return false;
      if (q.length === 0) return true;
      const haystack = [
        r.accountNumber,
        r.accountName,
        accountTypeLabel(r.accountType),
        detailTypeLabel(r.accountType, r.detailType),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, search, accountTypeFilter, balanceFilter]);

  // Group by gaap_type, then build trees, then flatten for rendering.
  // Anything outside GAAP_ORDER ends up under 'other'.
  const sections = useMemo(() => {
    const groups = new Map<string, AccountRow[]>();
    for (const r of filteredRows) {
      const key = GAAP_ORDER.some((g) => g.key === r.gaapType) ? r.gaapType : 'other';
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const ordered = [
      ...GAAP_ORDER,
      ...(groups.has('other') ? [{ key: 'other', label: 'Other' }] : []),
    ];
    return ordered.map((g) => {
      const tree = buildTree(groups.get(g.key) ?? []);
      return {
        key: g.key,
        label: g.label,
        flat: flattenTree(tree),
      };
    });
  }, [filteredRows]);

  return (
    <div className="flex flex-col gap-3">
      {/* Search + filters bar */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, number, or type..."
          className="flex-1 rounded-md border border-sky-200 bg-sky-50 px-4 py-2 text-sm placeholder:text-zinc-500 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 dark:border-sky-900/50 dark:bg-sky-950/30 dark:placeholder:text-zinc-500"
        />
        <select
          value={accountTypeFilter}
          onChange={(e) => setAccountTypeFilter(e.target.value)}
          className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-900/50 dark:bg-sky-950/30"
        >
          <option value="">All Account Types</option>
          {accountTypeOptions.map((o) => (
            <option key={o.slug} value={o.slug}>{o.label}</option>
          ))}
        </select>
        <select
          value={balanceFilter}
          onChange={(e) => setBalanceFilter(e.target.value)}
          className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-900/50 dark:bg-sky-950/30"
        >
          <option value="">All Balances</option>
          <option value="debit">Debit</option>
          <option value="credit">Credit</option>
        </select>
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          <a href={toggleHiddenHref} className="underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300">
            {toggleHiddenLabel}
          </a>
          {includesHidden && (
            <span className="ml-2 text-zinc-400">(inactive rows shown at 50% opacity)</span>
          )}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Account Number</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Account Name</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Account Type</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Detail Type</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Normal Balance</th>
              <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              const isCollapsed = collapsed[section.key] === true;
              const count = section.flat.length;
              return (
                <SectionRows
                  key={section.key}
                  section={section}
                  count={count}
                  isCollapsed={isCollapsed}
                  onToggle={() => setCollapsed((c) => ({ ...c, [section.key]: !isCollapsed }))}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionRows({
  section,
  count,
  isCollapsed,
  onToggle,
}: {
  section: { key: string; label: string; flat: Array<{ node: AccountNode; depth: number }> };
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-sky-200 bg-sky-50/60 dark:border-sky-900/40 dark:bg-sky-950/20">
        <td colSpan={6} className="px-4 py-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="flex items-center gap-2">
              <ChevronIcon collapsed={isCollapsed} />
              <span className="text-[13px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
                {section.label}
              </span>
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">({count})</span>
          </button>
        </td>
      </tr>

      {!isCollapsed && count === 0 && (
        <tr className="border-b border-zinc-100 dark:border-zinc-800">
          <td colSpan={6} className="px-4 py-6 text-center text-sm italic text-zinc-500">
            No accounts in this group
          </td>
        </tr>
      )}

      {!isCollapsed && section.flat.map(({ node, depth }) => {
        const inactive = node.isActive === false;
        return (
          <tr
            key={node.id}
            className={`border-b border-zinc-100 dark:border-zinc-800 ${inactive ? 'opacity-50' : ''}`}
          >
            <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{node.accountNumber}</td>
            <td
              className="px-4 py-2 text-zinc-800 dark:text-zinc-200"
              style={{ paddingLeft: `${1 + depth * 1.5}rem` }}
            >
              {depth > 0 && <span className="mr-1 text-zinc-400">└</span>}
              {node.accountName}
            </td>
            <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{accountTypeLabel(node.accountType)}</td>
            <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{detailTypeLabel(node.accountType, node.detailType)}</td>
            <td className="px-4 py-2">
              <BalancePill balance={node.normalBalance} />
            </td>
            <td className="px-4 py-2 text-right">
              <div className="flex items-center justify-end gap-2">
                <a
                  href={`/chart-of-accounts/${node.id}/edit`}
                  title="Edit"
                  className="rounded p-1 text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950/30"
                >
                  <PencilIcon />
                </a>
                <button
                  type="button"
                  title="Delete"
                  // Wire to a server action when delete UX is decided. For
                  // now no-op so the icon renders without misleading the user.
                  onClick={() => { /* TODO */ }}
                  className="rounded p-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  <TrashIcon />
                </button>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      className={`text-sky-600 transition-transform dark:text-sky-400 ${collapsed ? '-rotate-90' : ''}`}
      aria-hidden
    >
      <path d="M2 4l4 4 4-4z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function BalancePill({ balance }: { balance: string }) {
  const isDebit = balance === 'debit';
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isDebit
          ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
          : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      }`}
    >
      {balance}
    </span>
  );
}
