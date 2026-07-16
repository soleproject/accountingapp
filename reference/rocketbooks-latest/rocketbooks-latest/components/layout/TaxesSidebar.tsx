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
  Returns: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M8 12h2M8 16h2M14 11l2 2m0-2l-2 2" />
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
  emerald: 'text-emerald-600 dark:text-emerald-400',
};

const NAV: NavItem[] = [
  { href: '/taxes', label: 'Tax Returns', icon: Icon.Returns, color: C.emerald },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/taxes') return pathname === '/taxes' || pathname.startsWith('/taxes/');
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
}

export function TaxesSidebar({ workspaces, permissions, branding }: SidebarProps = {}) {
  const pathname = usePathname() ?? '';
  const [hydrated, setHydrated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    try {
      const isCollapsed = localStorage.getItem('rs_sidebar_collapsed') === '1';
      setCollapsed(isCollapsed);
      document.documentElement.style.setProperty('--rs-sidebar-w', isCollapsed ? '56px' : '224px');
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [pathname]);

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

  const visibleNav = useMemo(() => NAV.filter((n) => canSeePath(permissions, n.href)), [permissions]);

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
                <img src={branding.logoUrl} alt={branding.name} className={`h-12 w-full object-contain object-left ${branding.logoUrlDark ? 'dark:hidden' : ''}`} />
                {branding.logoUrlDark && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrlDark} alt={branding.name} className="hidden h-12 w-full object-contain object-left dark:block" />
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
            <WorkspaceSwitcher current="taxes" accessible={workspaces} collapsed={!effectiveExpanded} />
          </div>
        )}
        <nav className="flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
          {visibleNav.map((entry) => {
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
