'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WorkspaceSwitcher, type EnterpriseChoice } from './WorkspaceSwitcher';
import { switchEnterpriseAction } from '@/app/(enterprise)/enterprise/_actions/switchEnterprise';
import type { Workspace } from '@/lib/auth/workspace-types';

interface IconProps {
  className?: string;
}

const I = {
  Building: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
    </svg>
  ),
  Dashboard: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  Clients: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Review: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  Communications: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Billing: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  Staff: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><polyline points="17 11 19 13 23 9" />
    </svg>
  ),
  Activity: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  Share: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  Settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9" />
    </svg>
  ),
  Work: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
};

interface NavItem {
  href: string;
  label: string;
  icon: (p: IconProps) => React.ReactNode;
  color: string;
}

const NAV: NavItem[] = [
  { href: '/enterprise/dashboard', label: 'Dashboard', icon: I.Dashboard, color: 'text-blue-600 dark:text-blue-400' },
  { href: '/enterprise/clients', label: 'Clients', icon: I.Clients, color: 'text-emerald-600 dark:text-emerald-400' },
  { href: '/enterprise/businesses', label: 'Client Businesses', icon: I.Building, color: 'text-teal-600 dark:text-teal-400' },
  { href: '/enterprise/work', label: 'Work', icon: I.Work, color: 'text-orange-600 dark:text-orange-400' },
  { href: '/enterprise/review-accountability', label: 'Review', icon: I.Review, color: 'text-purple-600 dark:text-purple-400' },
  { href: '/enterprise/billing', label: 'Billing', icon: I.Billing, color: 'text-indigo-600 dark:text-indigo-400' },
  { href: '/enterprise/communications', label: 'Communications', icon: I.Communications, color: 'text-rose-600 dark:text-rose-400' },
  { href: '/enterprise/share', label: 'Share', icon: I.Share, color: 'text-sky-600 dark:text-sky-400' },
  { href: '/enterprise/staff', label: 'Staff', icon: I.Staff, color: 'text-violet-600 dark:text-violet-400' },
  { href: '/enterprise/activity', label: 'Activity', icon: I.Activity, color: 'text-amber-600 dark:text-amber-400' },
  { href: '/enterprise/settings', label: 'Settings', icon: I.Settings, color: 'text-zinc-600 dark:text-zinc-400' },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

interface Props {
  workspaces: Workspace[];
  enterpriseName?: string;
  enterprises?: EnterpriseChoice[];
  currentEnterpriseId?: string;
}

export function EnterpriseSidebar({ workspaces, enterpriseName, enterprises, currentEnterpriseId }: Props) {
  const pathname = usePathname() ?? '';
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const isCollapsed = localStorage.getItem('rs_sidebar_collapsed') === '1';
      setCollapsed(isCollapsed);
      document.documentElement.style.setProperty('--rs-sidebar-w', isCollapsed ? '56px' : '224px');
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

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
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
    }`;

  return (
    <div
      className={`relative h-screen shrink-0 transition-[width] duration-150 ${collapsed ? 'w-14' : 'w-56'}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <aside
        data-surface="sidebar"
        className={`absolute left-0 top-0 z-20 flex h-screen flex-col border-r border-zinc-200 bg-white p-4 transition-[width] duration-150 dark:border-zinc-800 dark:bg-zinc-950 ${
          effectiveExpanded ? 'w-56 shadow-xl shadow-black/5 dark:shadow-black/40' : 'w-14'
        }`}
      >
        <div className={`mb-1 flex items-center ${effectiveExpanded ? 'justify-between' : 'justify-center'}`}>
          <div className="flex items-center gap-2">
            <I.Building className="text-emerald-600 dark:text-emerald-400" />
            {effectiveExpanded && <span className="text-base font-semibold tracking-tight">Enterprise</span>}
          </div>
          {effectiveExpanded && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="11 17 6 12 11 7" />
              </svg>
            </button>
          )}
        </div>

        {effectiveExpanded && enterpriseName && (
          <div className="mb-4 truncate text-xs text-zinc-500 dark:text-zinc-400">{enterpriseName}</div>
        )}

        {hydrated && workspaces.length > 1 && (
          <div className="mb-3">
            <WorkspaceSwitcher
              current="enterprise"
              accessible={workspaces}
              collapsed={!effectiveExpanded}
              enterprises={enterprises}
              currentEnterpriseId={currentEnterpriseId}
              switchAction={switchEnterpriseAction}
            />
          </div>
        )}

        <nav className="flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
          {NAV.map((entry) => {
            const active = isActive(pathname, entry.href);
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
          })}
        </nav>

        {!effectiveExpanded && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
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
