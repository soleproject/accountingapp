'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
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
  if (!required) return true;
  return perms.keys.includes(required);
}

interface IconProps {
  className?: string;
}

const Icon = {
  Overview: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  Accounts: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  Transactions: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  Budget: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9" /><path d="M21 12a9 9 0 0 0-9-9v9z" />
    </svg>
  ),
  Cashflow: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  ),
  Recurring: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  ),
  Goals: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
    </svg>
  ),
  Reports: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><line x1="9" y1="13" x2="9" y2="17" /><line x1="13" y1="11" x2="13" y2="17" /><line x1="17" y1="15" x2="17" y2="17" />
    </svg>
  ),
  Categories: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  ),
  Settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Chevron: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
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

const C = {
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  rose: 'text-rose-600 dark:text-rose-400',
  pink: 'text-pink-600 dark:text-pink-400',
  amber: 'text-amber-600 dark:text-amber-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
  sky: 'text-sky-600 dark:text-sky-400',
  teal: 'text-teal-600 dark:text-teal-400',
};

const NAV: NavEntry[] = [
  { href: '/personal', label: 'Overview', icon: Icon.Overview, color: C.blue },
  { href: '/personal/accounts', label: 'Accounts', icon: Icon.Accounts, color: C.amber },
  { href: '/personal/transactions', label: 'Transactions', icon: Icon.Transactions, color: C.violet },
  { separator: true, key: 'sep-money' },
  { href: '/personal/budget', label: 'Budget', icon: Icon.Budget, color: C.emerald },
  { href: '/personal/cashflow', label: 'Cash Flow', icon: Icon.Cashflow, color: C.sky },
  { href: '/personal/recurring', label: 'Recurring', icon: Icon.Recurring, color: C.rose },
  { href: '/personal/goals', label: 'Goals', icon: Icon.Goals, color: C.teal },
  { separator: true, key: 'sep-insights' },
  { href: '/personal/reports', label: 'Reports', icon: Icon.Reports, color: C.pink },
  {
    key: 'more',
    label: 'More',
    icon: Icon.Settings,
    color: C.zinc,
    items: [
      { href: '/personal/categories', label: 'Categories', icon: Icon.Categories, color: C.amber },
      { href: '/personal/settings', label: 'Settings', icon: Icon.Settings, color: C.zinc },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  // Overview lives at the section root `/personal`; treat it as active only on
  // an exact match so it doesn't light up for every nested personal route.
  if (href === '/personal') return pathname === '/personal';
  return pathname === href || pathname.startsWith(href + '/');
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
  workspaces?: Workspace[];
  permissions?: ResolvedPermissions;
  branding?: EnterpriseBranding | null;
  hiddenNavPaths?: readonly string[];
}

function groupContainsActive(pathname: string, group: NavGroup): boolean {
  return group.items.some((it) => isActive(pathname, it.href));
}

export function PersonalSidebar({ workspaces, permissions, branding, hiddenNavPaths }: SidebarProps = {}) {
  const hiddenSet = useMemo(() => new Set(hiddenNavPaths ?? []), [hiddenNavPaths]);
  const pathname = usePathname() ?? '';
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);

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
      document.documentElement.style.setProperty('--rs-sidebar-w', isCollapsed ? '56px' : '224px');
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [pathname]);

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
        document.cookie = `rs_sidebar_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; SameSite=Lax`;
        document.documentElement.style.setProperty('--rs-sidebar-w', next ? '56px' : '224px');
      } catch {
        // ignore
      }
      return next;
    });
  };

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

  // Resolve the nav to what is actually visible, then drop separators that
  // would dangle once permission/flag-hidden entries are filtered out.
  const isEntryVisible = (e: NavEntry): boolean => {
    if (isSeparator(e)) return true;
    if (isGroup(e)) return e.items.some((it) => canSeePath(permissions, it.href) && !hiddenSet.has(it.href));
    return canSeePath(permissions, e.href) && !hiddenSet.has(e.href);
  };
  const navEntries: NavEntry[] = [];
  for (const e of NAV.filter(isEntryVisible)) {
    if (isSeparator(e) && (navEntries.length === 0 || isSeparator(navEntries[navEntries.length - 1]))) continue;
    navEntries.push(e);
  }
  while (navEntries.length > 0 && isSeparator(navEntries[navEntries.length - 1])) navEntries.pop();

  return (
    <div
      className={`relative h-screen shrink-0 transition-[width] duration-150 ${collapsed ? 'w-14' : 'w-56'}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <aside
        className={`absolute left-0 top-0 z-20 flex h-screen flex-col border-r border-zinc-200 bg-white p-4 transition-[width] duration-150 dark:border-zinc-800 dark:bg-zinc-950 ${
          effectiveExpanded ? 'w-56 shadow-xl shadow-black/5 dark:shadow-black/40' : 'w-14'
        }`}
      >
        <div className={`mb-6 flex items-center ${effectiveExpanded ? 'justify-between' : 'justify-center'}`}>
          {effectiveExpanded ? (
            branding?.logoUrl ? (
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={branding.logoUrl}
                  alt={branding.name}
                  className={`h-12 w-full object-contain object-left ${branding.logoUrlDark ? 'dark:hidden' : ''}`}
                />
                {branding.logoUrlDark && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrlDark} alt={branding.name} className="hidden h-12 w-full object-contain object-left dark:block" />
                )}
                {branding.poweredByEnabled && (
                  <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                    {branding.poweredByText || 'Powered by RocketSuite'}
                  </span>
                )}
              </div>
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/rocketbooks-logo.png" alt="RocketSuite" title="RocketSuite" className="h-14 w-full object-contain object-left dark:hidden" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/rocketbooks-logo-dark.png" alt="RocketSuite" title="RocketSuite" className="hidden h-14 w-full object-contain object-left dark:block" />
              </>
            )
          ) : branding?.logoUrl ? (
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
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/rocketbooks-icon.png" alt="RocketSuite" title="RocketSuite" className="h-8 w-8 object-contain dark:hidden" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/rocketbooks-icon-dark.png" alt="RocketSuite" title="RocketSuite" className="hidden h-8 w-8 object-contain dark:block" />
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
                {collapsed ? <polyline points="13 17 18 12 13 7" /> : <polyline points="11 17 6 12 11 7" />}
              </svg>
            </button>
          )}
        </div>
        {workspaces && workspaces.length > 1 && (
          <div className="mb-3">
            <WorkspaceSwitcher current="personal" accessible={workspaces} collapsed={!effectiveExpanded} />
          </div>
        )}
        <nav className="flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
          {navEntries.map((entry) => {
            if (isSeparator(entry)) {
              return (
                <div
                  key={entry.key}
                  role="separator"
                  aria-orientation="horizontal"
                  className="my-2 border-t border-zinc-200 dark:border-zinc-800"
                />
              );
            }
            if (!isGroup(entry)) {
              if (!canSeePath(permissions, entry.href)) return null;
              if (hiddenSet.has(entry.href)) return null;
              const active = hydrated && isActive(pathname, entry.href);
              return (
                <Link
                  prefetch={false}
                  key={entry.href}
                  href={entry.href}
                  title={!effectiveExpanded ? entry.label : undefined}
                  className={`${itemClass(active)} ${effectiveExpanded ? '' : 'justify-center px-2'}`}
                >
                  <entry.icon className={`shrink-0 ${entry.color}`} />
                  {effectiveExpanded && <span className="flex-1 truncate">{entry.label}</span>}
                </Link>
              );
            }

            const visibleItems = entry.items.filter(
              (it) => canSeePath(permissions, it.href) && !hiddenSet.has(it.href),
            );
            if (visibleItems.length === 0) return null;
            const open = hydrated ? !!openGroups[entry.key] : groupContainsActive(pathname, entry);
            const groupActive = hydrated && groupContainsActive(pathname, entry);
            return (
              <div key={entry.key} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggleGroup(entry.key)}
                  aria-expanded={open}
                  data-nav-group={entry.key}
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
                      return (
                        <Link prefetch={false} key={sub.href} href={sub.href} className={subItemClass(active)}>
                          <sub.icon className={`shrink-0 ${sub.color}`} />
                          <span className="flex-1 truncate">{sub.label}</span>
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
