'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import type { Workspace } from '@/lib/auth/workspace-types';
import { permissionKeyForPath } from '@/lib/permissions/structure';

interface ResolvedPermissions {
  keys: string[];
  mode: 'allow_all' | 'set';
}

function canSeePath(perms: ResolvedPermissions | undefined, href: string): boolean {
  if (!perms || perms.mode === 'allow_all') return true;
  const required = permissionKeyForPath(href);
  if (!required) return true; // path not in catalog → not gated
  return perms.keys.includes(required);
}

interface IconProps {
  className?: string;
}

const Icon = {
  Dashboard: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  AI: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z" />
    </svg>
  ),
  Pulse: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  ),
  Tasks: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  Invoices: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  Bills: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 4v17l3-2 3 2 3-2 3 2 3-2 3 2V4l-3 2-3-2-3 2-3-2-3 2-3-2z" /><path d="M8 9h8M8 13h6" />
    </svg>
  ),
  Payments: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  Receipts: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2H4z" /><path d="M8 7h8M8 11h8M8 15h5" />
    </svg>
  ),
  Reports: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  Contacts: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Connections: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  Imports: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  Bank: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v4M12 14v4M16 14v4" />
    </svg>
  ),
  Feed: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  Accounting: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  QuickBooks: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 8a4 4 0 1 0 4 4M14 14l2 3" />
    </svg>
  ),
  Transactions: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  HighLevel: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polygon points="3 4 21 4 14 12 14 19 10 21 10 12 3 4" />
    </svg>
  ),
  Reconciliation: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="1 9 5 13 13 5" /><polyline points="11 13 15 17 23 9" />
    </svg>
  ),
  Inventory: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  COA: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h12" />
    </svg>
  ),
  Journal: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z" /><path d="M8 7h8M8 11h6" />
    </svg>
  ),
  Activity: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Billing: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  Feedback: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  Inbox: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  Settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Loans: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 8v8M9.5 10h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h5" />
    </svg>
  ),
  Chevron: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  Share: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
};

interface NavItem {
  href: string;
  label: string;
  icon: (p: IconProps) => React.ReactNode;
  color: string;
}

interface NavGroup {
  key: string;
  label: string;
  icon: (p: IconProps) => React.ReactNode;
  color: string;
  items: NavItem[];
}

interface NavSeparator {
  separator: true;
  key: string;
}

type NavEntry = NavItem | NavGroup | NavSeparator;

function isGroup(e: NavEntry): e is NavGroup {
  return 'items' in e;
}

function isSeparator(e: NavEntry): e is NavSeparator {
  return 'separator' in e;
}

// Per-item icon color. Light mode uses 600, dark uses 400 for contrast.
const C = {
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  sky: 'text-sky-600 dark:text-sky-400',
  amber: 'text-amber-600 dark:text-amber-400',
  green: 'text-green-600 dark:text-green-400',
  orange: 'text-orange-600 dark:text-orange-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  pink: 'text-pink-600 dark:text-pink-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  teal: 'text-teal-600 dark:text-teal-400',
  purple: 'text-purple-600 dark:text-purple-400',
  rose: 'text-rose-600 dark:text-rose-400',
  yellow: 'text-yellow-600 dark:text-yellow-400',
  slate: 'text-slate-600 dark:text-slate-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
};

const NAV: NavEntry[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Icon.Dashboard, color: C.blue },
  { href: '/pulse', label: 'Pulse', icon: Icon.Pulse, color: C.rose },
  { href: '/ai-chat', label: 'AI Assistant', icon: Icon.AI, color: C.violet },
  { href: '/tasks', label: 'Tasks', icon: Icon.Tasks, color: C.emerald },
  {
    key: 'trust',
    label: 'Trust',
    icon: Icon.Tasks,
    color: C.amber,
    items: [
      { href: '/trust-review', label: 'Trust Review', icon: Icon.Tasks, color: C.amber },
      { href: '/trust-beneficiaries', label: 'Trust Beneficiaries', icon: Icon.Contacts, color: C.amber },
      { href: '/trust-documents', label: 'Trust Documents', icon: Icon.Reports, color: C.amber },
    ],
  },
  { separator: true, key: 'sep-tasks-invoices' },
  { href: '/invoices', label: 'Invoices', icon: Icon.Invoices, color: C.sky },
  { href: '/bills', label: 'Bills', icon: Icon.Bills, color: C.amber },
  { href: '/payments', label: 'Payments', icon: Icon.Payments, color: C.green },
  { href: '/receipts', label: 'Receipts', icon: Icon.Receipts, color: C.orange },
  { href: '/reports', label: 'Reports', icon: Icon.Reports, color: C.indigo },
  { href: '/contacts', label: 'Contacts', icon: Icon.Contacts, color: C.pink },
  {
    key: 'connections',
    label: 'Connections',
    icon: Icon.Connections,
    color: C.cyan,
    items: [
      { href: '/imports', label: 'Imports', icon: Icon.Imports, color: C.teal },
      { href: '/integrations/plaid', label: 'Bank Connections', icon: Icon.Bank, color: C.amber },
      { href: '/plaid-feed', label: 'Plaid Feed', icon: Icon.Feed, color: C.blue },
      { href: '/integrations/qbo', label: 'QBO Connection', icon: Icon.QuickBooks, color: C.green },
      { href: '/integrations/ghl', label: 'GHL Connection', icon: Icon.HighLevel, color: C.indigo },
    ],
  },
  { href: '/connections/communications', label: 'Communications', icon: Icon.Inbox, color: C.violet },
  { separator: true, key: 'sep-connections-accounting' },
  {
    key: 'accounting',
    label: 'Accounting',
    icon: Icon.Accounting,
    color: C.slate,
    items: [
      { href: '/transactions', label: 'Transactions', icon: Icon.Transactions, color: C.purple },
      { href: '/inventory', label: 'Inventory', icon: Icon.Inventory, color: C.teal },
      { href: '/assets', label: 'Assets', icon: Icon.Dashboard, color: C.indigo },
      { href: '/loans', label: 'Loans', icon: Icon.Loans, color: C.amber },
      { href: '/tags', label: 'Tags', icon: Icon.Dashboard, color: C.amber },
      { href: '/rental-properties', label: 'Rental Properties', icon: Icon.Dashboard, color: C.green },
      { href: '/reconciliation', label: 'Reconciliation', icon: Icon.Reconciliation, color: C.green },
      { href: '/book-review', label: 'Book Review', icon: Icon.Tasks, color: C.amber },
      { href: '/period-close', label: 'Close the Books', icon: Icon.Reconciliation, color: C.teal },
      { href: '/year-end-close', label: 'Year-End Close', icon: Icon.Tasks, color: C.emerald },
      { href: '/chart-of-accounts', label: 'Chart of Accounts', icon: Icon.COA, color: C.slate },
      { href: '/journal-entries', label: 'Journal Entries', icon: Icon.Journal, color: C.indigo },
      { href: '/general-ledger', label: 'General Ledger', icon: Icon.Journal, color: C.indigo },
      { href: '/substantiation', label: 'IRS Docs', icon: Icon.Tasks, color: C.rose },
    ],
  },
  { href: '/share', label: 'Share', icon: Icon.Share, color: C.sky },
  {
    key: 'more',
    label: 'More',
    icon: Icon.Settings,
    color: C.zinc,
    items: [
      { href: '/businesses', label: 'Businesses', icon: Icon.Dashboard, color: C.blue },
      { href: '/billing', label: 'Billing', icon: Icon.Billing, color: C.emerald },
      { href: '/settings', label: 'Settings', icon: Icon.Settings, color: C.zinc },
      { href: '/activity', label: 'Activity', icon: Icon.Activity, color: C.yellow },
      { href: '/feedback', label: 'Feedback', icon: Icon.Feedback, color: C.pink },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

function NavBadge({ count }: { count: number }) {
  const display = count > 999 ? '999+' : String(count);
  return (
    <span
      className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium leading-tight text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      aria-label={`${count} items needing review`}
    >
      {display}
    </span>
  );
}

function groupContainsActive(pathname: string, group: NavGroup): boolean {
  return group.items.some((it) => isActive(pathname, it.href));
}

interface EnterpriseBranding {
  enterpriseId: string;
  name: string;
  logoUrl: string | null;
  logoUrlDark: string | null;
  logoIconUrl: string | null;
  logoIconDarkUrl: string | null;
  poweredByEnabled: boolean;
  poweredByText: string | null;
}

interface SidebarProps {
  /** Map of nav href → integer count to render as a badge. */
  badges?: Record<string, number>;
  /** Workspaces this user can switch between. Always includes 'main'. */
  workspaces?: Workspace[];
  /** Resolved permission keys + mode. Drives nav-item visibility. */
  permissions?: ResolvedPermissions;
  /** Branding for the user's enterprise (if any). Drives sidebar header logo. */
  branding?: EnterpriseBranding | null;
  /** Nav paths to hide for this org (feature-gated items). E.g. '/trust-review'
   *  is only shown when the org has a trust entity type. Array (not Set) so it
   *  serializes cleanly across the server/client boundary. */
  hiddenNavPaths?: readonly string[];
}

const ACCOUNTING_WORKSPACE: Workspace = {
  key: 'main',
  label: 'Accounting',
  href: '/dashboard',
};

export function Sidebar({ badges, workspaces, permissions, branding, hiddenNavPaths }: SidebarProps = {}) {
  const [hydratedHiddenNavPaths, setHydratedHiddenNavPaths] = useState<readonly string[]>(hiddenNavPaths ?? []);
  const hiddenSet = useMemo(() => new Set(hydratedHiddenNavPaths), [hydratedHiddenNavPaths]);
  const pathname = usePathname() ?? '';
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setHydratedHiddenNavPaths(hiddenNavPaths ?? []);
  }, [hiddenNavPaths]);

  // Trust nav visibility is decided server-side by the org's entity type
  // (see app/(app)/layout.tsx). No client-side feature-pack un-hide — an org
  // that isn't a trust entity must never reveal trust nav, regardless of any
  // accounting feature flag.

  useEffect(() => {
    let saved: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem('rs_nav_groups');
      if (raw) saved = JSON.parse(raw) as Record<string, boolean>;
    } catch {
      // ignore
    }
    const next: Record<string, boolean> = { ...saved };
    for (const e of NAV) {
      if (isGroup(e) && next[e.key] === undefined) {
        next[e.key] = groupContainsActive(pathname, e);
      }
    }
    setOpenGroups(next);
    try {
      const isCollapsed = localStorage.getItem('rs_sidebar_collapsed') === '1';
      setCollapsed(isCollapsed);
      // Keep --rs-sidebar-w (set pre-hydration by sidebarBootstrap in
      // app/layout.tsx) in sync if storage drifted between bootstrap and now.
      document.documentElement.style.setProperty(
        '--rs-sidebar-w',
        isCollapsed ? '56px' : '224px',
      );
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [pathname]);

  // Regular-tour sidebar spotlight: GuidedTour dispatches
  // `rs:tour-nav-spotlight` with `{ href }` as it narrates each step. We
  // open the parent group (if any) so the sub-item is rendered, then add
  // the ring class to the matching link. `href: null` clears the ring.
  // Falls back to highlighting the group button when the sub-item isn't
  // in the DOM (sidebar collapsed, or render race).
  useEffect(() => {
    const clearSpotlight = () => {
      document
        .querySelectorAll('.rs-tour-nav-spotlight')
        .forEach((el) => el.classList.remove('rs-tour-nav-spotlight'));
      navRef.current?.classList.remove('rs-tour-nav-dimmed');
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ href: string | null }>).detail;
      const href = detail?.href ?? null;
      clearSpotlight();
      if (!href) return;
      const parent = NAV.find(
        (entry): entry is NavGroup =>
          isGroup(entry) && entry.items.some((it) => it.href === href),
      );
      if (parent) {
        setOpenGroups((prev) => (prev[parent.key] ? prev : { ...prev, [parent.key]: true }));
      }
      // Wait a paint for the group expansion / route change to settle so
      // the sub-item Link exists in the DOM. clearSpotlight() again inside
      // the rAF so a second event firing between the synchronous clear and
      // this rAF can't leave two highlights on screen.
      requestAnimationFrame(() => {
        const escaped =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(href)
            : href.replace(/"/g, '\\"');
        const target =
          (document.querySelector(`[data-tour-nav-href="${escaped}"]`) as HTMLElement | null)
          ?? (parent
            ? (document.querySelector(`[data-tour-nav-group="${parent.key}"]`) as HTMLElement | null)
            : null);
        if (target) {
          clearSpotlight();
          target.classList.add('rs-tour-nav-spotlight');
          navRef.current?.classList.add('rs-tour-nav-dimmed');
        }
      });
    };
    window.addEventListener('rs:tour-nav-spotlight', handler);
    return () => {
      window.removeEventListener('rs:tour-nav-spotlight', handler);
      clearSpotlight();
    };
  }, []);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem('rs_nav_groups', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem('rs_sidebar_collapsed', next ? '1' : '0');
        // Mirror into a cookie so root layout can SSR --rs-sidebar-w on
        // the next request (avoids a pre-hydration bootstrap script).
        document.cookie = `rs_sidebar_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; SameSite=Lax`;
        document.documentElement.style.setProperty(
          '--rs-sidebar-w',
          next ? '56px' : '224px',
        );
      } catch {
        // ignore
      }
      return next;
    });
  };

  // The sidebar reserves a narrow width when collapsed but visually expands
  // (overlaying content) on hover. effectiveExpanded drives the inner layout
  // and label visibility.
  const effectiveExpanded = !collapsed || hovering;

  const itemClass = (active: boolean) =>
    `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
      active
        ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
    }`;

  const subItemClass = (active: boolean) =>
    `flex items-center gap-2.5 rounded-md py-1.5 pl-8 pr-3 text-sm transition-colors ${
      active
        ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
        : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
    }`;

  return (
    <div
      className={`relative h-screen shrink-0 transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-56'
      }`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <aside
        data-surface="sidebar"
        className={`absolute left-0 top-0 z-20 flex h-screen flex-col border-r border-zinc-200 bg-white p-4 transition-[width] duration-150 dark:border-zinc-800 dark:bg-zinc-950 ${
          effectiveExpanded ? 'w-56 shadow-xl shadow-black/5 dark:shadow-black/40' : 'w-14'
        } ${collapsed && !hovering ? '' : ''}`}
      >
        <div className={`mb-6 flex items-center ${effectiveExpanded ? 'justify-between' : 'justify-center'}`}>
          {effectiveExpanded ? (
            branding?.logoUrl ? (
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                {/* Theme-aware custom wordmark: dark variant in dark mode, else light. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={branding.logoUrl}
                  alt={branding.name}
                  className={`h-12 w-full object-contain object-left ${branding.logoUrlDark ? 'dark:hidden' : ''}`}
                />
                {branding.logoUrlDark && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={branding.logoUrlDark}
                    alt={branding.name}
                    className="hidden h-12 w-full object-contain object-left dark:block"
                  />
                )}
                {branding.poweredByEnabled && (
                  <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                    {branding.poweredByText || 'Powered by RocketSuite'}
                  </span>
                )}
              </div>
            ) : (
              // Theme-aware default wordmark: dark-text for light mode,
              // white-text for dark mode.
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/rocketbooks-logo.png"
                  alt="RocketSuite"
                  title="RocketSuite"
                  className="h-14 w-full object-contain object-left dark:hidden"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/rocketbooks-logo-dark.png"
                  alt="RocketSuite"
                  title="RocketSuite"
                  className="hidden h-14 w-full object-contain object-left dark:block"
                />
              </>
            )
          ) : branding?.logoUrl ? (
            // Collapsed custom branding: prefer the icon variant, theme-aware.
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={branding.logoIconUrl ?? branding.logoUrl}
                alt={branding.name}
                title={branding.name}
                className={`h-7 w-7 rounded object-contain ${branding.logoIconDarkUrl || branding.logoUrlDark ? 'dark:hidden' : ''}`}
              />
              {(branding.logoIconDarkUrl || branding.logoUrlDark) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={branding.logoIconDarkUrl ?? branding.logoUrlDark ?? branding.logoIconUrl ?? branding.logoUrl}
                  alt={branding.name}
                  title={branding.name}
                  className="hidden h-7 w-7 rounded object-contain dark:block"
                />
              )}
            </>
          ) : (
            // Theme-aware collapsed icon: dark "R" for light mode, white "R" for dark mode.
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/rocketbooks-icon.png"
                alt="RocketSuite"
                title="RocketSuite"
                className="h-8 w-8 object-contain dark:hidden"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/rocketbooks-icon-dark.png"
                alt="RocketSuite"
                title="RocketSuite"
                className="hidden h-8 w-8 object-contain dark:block"
              />
            </>
          )}
          {effectiveExpanded && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {collapsed ? (
                  <polyline points="13 17 18 12 13 7" />
                ) : (
                  <polyline points="11 17 6 12 11 7" />
                )}
              </svg>
            </button>
          )}
        </div>
        {(workspaces === undefined || workspaces.length > 1) && (
          <div className="mb-3">
            <WorkspaceSwitcher
              current="main"
              accessible={workspaces ?? [ACCOUNTING_WORKSPACE]}
              optionsEndpoint={workspaces === undefined ? '/api/workspaces/options' : undefined}
              collapsed={!effectiveExpanded}
            />
          </div>
        )}
        <nav ref={navRef} className="flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
          {NAV.map((entry) => {
            if (isSeparator(entry)) {
              return (
                <hr
                  key={entry.key}
                  className="my-1 border-t border-zinc-300 dark:border-zinc-700"
                  aria-hidden="true"
                />
              );
            }
            if (!isGroup(entry)) {
              if (!canSeePath(permissions, entry.href)) return null;
              if (hiddenSet.has(entry.href)) return null;
              // Defer the active highlight until after hydration. Otherwise
              // SSR (no usePathname()) and the initial client render can
              // disagree on which link is active, producing a hydration
              // mismatch on the className.
              const active = hydrated && isActive(pathname, entry.href);
              const badge = badges?.[entry.href] ?? 0;
              return (
                <Link
                  prefetch={false}
                  key={entry.href}
                  href={entry.href}
                  title={!effectiveExpanded ? entry.label : undefined}
                  data-tour-nav-href={entry.href}
                  className={`${itemClass(active)} ${effectiveExpanded ? '' : 'justify-center px-2'}`}
                >
                  <entry.icon className={`shrink-0 ${entry.color}`} />
                  {effectiveExpanded && <span className="flex-1 truncate">{entry.label}</span>}
                  {effectiveExpanded && badge > 0 && <NavBadge count={badge} />}
                </Link>
              );
            }

            const visibleItems = entry.items.filter(
              (it) => canSeePath(permissions, it.href) && !hiddenSet.has(it.href),
            );
            if (visibleItems.length === 0) return null;
            const open = hydrated ? !!openGroups[entry.key] : groupContainsActive(pathname, entry);
            // Group highlight gated on hydrated, same reasoning as the
            // per-item active check below.
            const groupActive = hydrated && groupContainsActive(pathname, entry);
            return (
              <div key={entry.key} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggleGroup(entry.key)}
                  aria-expanded={open}
                  data-nav-group={entry.key}
                  data-tour-nav-group={entry.key}
                  title={!effectiveExpanded ? entry.label : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                    !effectiveExpanded ? 'justify-center px-2' : ''
                  } ${
                    groupActive
                      ? 'text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
                  }`}
                >
                  <entry.icon className={`shrink-0 ${entry.color}`} />
                  {effectiveExpanded && (
                    <>
                      <span className="flex-1 truncate text-left">{entry.label}</span>
                      <Icon.Chevron className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                    </>
                  )}
                </button>
                {effectiveExpanded && open && (
                  <div className="flex flex-col gap-0.5">
                    {visibleItems.map((sub) => {
                      const active = hydrated && isActive(pathname, sub.href);
                      const badge = badges?.[sub.href] ?? 0;
                      return (
                        <Link
                          prefetch={false}
                          key={sub.href}
                          href={sub.href}
                          data-tour-nav-href={sub.href}
                          className={subItemClass(active)}
                        >
                          <sub.icon className={`shrink-0 ${sub.color}`} />
                          <span className="flex-1 truncate">{sub.label}</span>
                          {badge > 0 && <NavBadge count={badge} />}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        {!effectiveExpanded && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="mt-auto flex h-8 w-full items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="13 17 18 12 13 7" />
            </svg>
          </button>
        )}
      </aside>
    </div>
  );
}
