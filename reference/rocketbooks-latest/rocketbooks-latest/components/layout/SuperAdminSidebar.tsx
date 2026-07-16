'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import type { Workspace } from '@/lib/auth/workspace-types';

interface IconProps {
  className?: string;
}

const I = {
  Shield: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  Dashboard: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  Admin: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  Enterprise: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
    </svg>
  ),
  Users: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  UserCheck: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" />
      <polyline points="17 11 19 13 23 9" />
    </svg>
  ),
  Activity: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  Sparkles: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </svg>
  ),
  Image: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  Key: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  ),
  Tag: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  ),
  MessageSquare: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  Mail: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  Phone: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  Cpu: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
  ),
  Settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

interface NavItem {
  href: string;
  label: string;
  icon: (p: IconProps) => React.ReactNode;
  color: string;
}

const C = {
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  pink: 'text-pink-600 dark:text-pink-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
};

const NAV: NavItem[] = [
  { href: '/super-admin/dashboard', label: 'Dashboard', icon: I.Dashboard, color: C.blue },
  { href: '/super-admin/agents', label: 'Agents', icon: I.Cpu, color: C.indigo },
  { href: '/super-admin/admin', label: 'Admin', icon: I.Admin, color: C.violet },
  { href: '/super-admin/enterprises', label: 'Enterprises', icon: I.Enterprise, color: C.cyan },
  { href: '/super-admin/enterprise-users', label: 'Enterprise Users', icon: I.UserCheck, color: C.indigo },
  { href: '/super-admin/all-users', label: 'All Users', icon: I.Users, color: C.emerald },
  { href: '/super-admin/activity-log', label: 'Activity Log', icon: I.Activity, color: C.amber },
  { href: '/super-admin/ai-usage', label: 'Usage & Costs', icon: I.Sparkles, color: C.violet },
  { href: '/super-admin/logos-report', label: 'Logos Report', icon: I.Image, color: C.pink },
  { href: '/super-admin/permission-sets', label: 'Permission Sets', icon: I.Key, color: C.violet },
  { href: '/super-admin/products', label: 'Billing Products', icon: I.Tag, color: C.emerald },
  { href: '/super-admin/feedback', label: 'Feedback', icon: I.MessageSquare, color: C.pink },
  { href: '/super-admin/communications', label: 'Communications', icon: I.Mail, color: C.blue },
  { href: '/super-admin/settings', label: 'Settings', icon: I.Settings, color: C.zinc },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

interface Props {
  workspaces: Workspace[];
}

export function SuperAdminSidebar({ workspaces }: Props) {
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
        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
    }`;

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
          <div className={`flex items-center gap-2 ${effectiveExpanded ? '' : 'justify-center'}`}>
            <I.Shield className="text-blue-600 dark:text-blue-400" />
            {effectiveExpanded && <span className="text-base font-semibold tracking-tight">Super Admin</span>}
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

        {hydrated && workspaces.length > 1 && (
          <div className="mb-3">
            <WorkspaceSwitcher current="super-admin" accessible={workspaces} collapsed={!effectiveExpanded} />
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
