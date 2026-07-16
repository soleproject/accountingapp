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
  Dashboard: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  Pulse: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  ),
  AI: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z" />
    </svg>
  ),
  Calendar: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  Mic: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  ),
  Video: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ),
  Notes: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  ),
  Chat: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  Tasks: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  Contacts: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Activity: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Feedback: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  Billing: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  Settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Inbox: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  Signature: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 17c3 0 4-9 6-9s2 6 4 6 2-3 5-3" /><path d="M3 21h18" />
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
  yellow: 'text-yellow-600 dark:text-yellow-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
  sky: 'text-sky-600 dark:text-sky-400',
};

const NAV: NavEntry[] = [
  { href: '/organizer/dashboard', label: 'Dashboard', icon: Icon.Dashboard, color: C.blue },
  { href: '/organizer/calendar', label: 'Calendar', icon: Icon.Calendar, color: C.sky },
  { href: '/organizer/tasks', label: 'Tasks', icon: Icon.Tasks, color: C.emerald },
  { separator: true, key: 'sep-tasks' },
  { href: '/organizer/texts', label: 'Texts', icon: Icon.Chat, color: C.emerald },
  { href: '/organizer/inbox', label: 'Inbox', icon: Icon.Inbox, color: C.blue },
  { href: '/organizer/video', label: 'Video', icon: Icon.Video, color: C.sky },
  { separator: true, key: 'sep-video' },
  { href: '/organizer/notetaker', label: 'Notetaker', icon: Icon.Notes, color: C.sky },
  { href: '/organizer/recorder', label: 'Recorder', icon: Icon.Mic, color: C.sky },
  { href: '/organizer/documents', label: 'Documents', icon: Icon.Dashboard, color: C.violet },
  { href: '/organizer/signatures', label: 'Signatures', icon: Icon.Signature, color: C.violet },
  { separator: true, key: 'sep-docs' },
  { href: '/organizer/contacts', label: 'Contacts', icon: Icon.Contacts, color: C.pink },
  // Pulse and AI Assistant are hidden from the organizer nav via hiddenNavPaths
  // in the organizer layout; kept here so the entries/permissions stay defined.
  { href: '/organizer/pulse', label: 'Pulse', icon: Icon.Pulse, color: C.rose },
  { href: '/organizer/ai-chat', label: 'AI Assistant', icon: Icon.AI, color: C.violet },
  {
    key: 'more',
    label: 'More',
    icon: Icon.Settings,
    color: C.zinc,
    items: [
      { href: '/organizer/businesses', label: 'Businesses', icon: Icon.Dashboard, color: C.blue },
      { href: '/organizer/letterhead', label: 'Letterhead', icon: Icon.Settings, color: C.zinc },
      { href: '/organizer/activity', label: 'Activity', icon: Icon.Activity, color: C.yellow },
      { href: '/organizer/feedback', label: 'Feedback', icon: Icon.Feedback, color: C.pink },
      { href: '/organizer/billing', label: 'Billing', icon: Icon.Billing, color: C.emerald },
      { href: '/organizer/settings', label: 'Settings', icon: Icon.Settings, color: C.zinc },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
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
  badges?: Record<string, number>;
  workspaces?: Workspace[];
  permissions?: ResolvedPermissions;
  branding?: EnterpriseBranding | null;
  hiddenNavPaths?: readonly string[];
}

export function OrganizerSidebar({ badges, workspaces, permissions, branding, hiddenNavPaths }: SidebarProps = {}) {
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
      document.documentElement.style.setProperty(
        '--rs-sidebar-w',
        isCollapsed ? '56px' : '224px',
      );
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
  // would dangle — leading, trailing, or doubled up once permission/flag
  // hidden entries are filtered out — so we never render a stray divider.
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
      className={`relative h-screen shrink-0 transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-56'
      }`}
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
              // white-text for dark mode. eslint-disable for plain <img>.
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
        {workspaces && workspaces.length > 1 && (
          <div className="mb-3">
            <WorkspaceSwitcher current="organizer" accessible={workspaces} collapsed={!effectiveExpanded} />
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
              const badge = badges?.[entry.href] ?? 0;
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
                  {effectiveExpanded && badge > 0 && <NavBadge count={badge} />}
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
                      const badge = badges?.[sub.href] ?? 0;
                      return (
                        <Link prefetch={false} key={sub.href} href={sub.href} className={subItemClass(active)}>
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
