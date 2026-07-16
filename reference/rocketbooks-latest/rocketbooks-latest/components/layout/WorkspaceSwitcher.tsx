'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { Workspace, WorkspaceKey } from '@/lib/auth/workspace-types';

export interface EnterpriseChoice {
  id: string;
  name: string;
}

interface Props {
  current: WorkspaceKey;
  accessible: Workspace[];
  collapsed?: boolean;
  /**
   * Optional list of enterprises the user can switch between. When provided
   * and length > 1, they're listed inside the dropdown under the
   * "Enterprise" entry. Selecting one writes the active-enterprise cookie
   * via switchAction and reloads /enterprise/dashboard.
   */
  enterprises?: EnterpriseChoice[];
  currentEnterpriseId?: string;
  switchAction?: (formData: FormData) => Promise<void>;
  optionsEndpoint?: string;
}

const ICON: Record<WorkspaceKey, React.ReactNode> = {
  main: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  organizer: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  taxes: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M8 12h2M8 16h2M14 11l2 2m0-2l-2 2" />
    </svg>
  ),
  personal: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <path d="M21 12a2 2 0 0 0-2-2h-5a2 2 0 0 0 0 4h5a2 2 0 0 0 2-2z" />
    </svg>
  ),
  'super-admin': (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  enterprise: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
    </svg>
  ),
};

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const BuildingIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="2" width="16" height="20" rx="1" />
    <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
  </svg>
);

// Generic clock used for not-yet-built ("Soon") placeholder items.
const SoonIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);

/**
 * Grouped layout for the workspace switcher. Group titles ("Business",
 * "Personal", "Admin") are non-clickable section headers. Each item is either
 * a real workspace (rendered only when the user can access it) or a "soon"
 * placeholder for a planned-but-unbuilt area. A group is hidden entirely when
 * none of its items are visible. Ordering follows the product roadmap mock.
 */
type GroupItem =
  | { kind: 'workspace'; key: WorkspaceKey; label?: string }
  | { kind: 'soon'; label: string };

interface Group {
  title: string;
  /** Tailwind text-color class for the section header (light + dark). */
  headerClass: string;
  /** Light background wash applied to the whole section block. */
  tintClass: string;
  items: GroupItem[];
}

const GROUPS: Group[] = [
  {
    title: 'Business',
    headerClass: 'text-blue-600 dark:text-blue-400',
    tintClass: 'bg-blue-100 dark:bg-blue-950/40',
    items: [
      { kind: 'workspace', key: 'organizer' },
      { kind: 'workspace', key: 'main' }, // "Accounting"
      { kind: 'workspace', key: 'taxes' },
      { kind: 'soon', label: 'Payroll' },
    ],
  },
  {
    title: 'Personal',
    headerClass: 'text-emerald-600 dark:text-emerald-400',
    tintClass: 'bg-emerald-100 dark:bg-emerald-950/40',
    items: [
      { kind: 'soon', label: 'Daily' },
      { kind: 'workspace', key: 'personal', label: 'Finances' },
      { kind: 'soon', label: 'Credit' },
      { kind: 'soon', label: 'Physical' },
      { kind: 'soon', label: 'Mental' },
    ],
  },
  {
    title: 'Admin',
    headerClass: 'text-amber-600 dark:text-amber-400',
    tintClass: 'bg-amber-100 dark:bg-amber-950/40',
    items: [
      { kind: 'workspace', key: 'super-admin', label: 'SuperAdmin' },
      { kind: 'workspace', key: 'enterprise' },
      { kind: 'soon', label: 'Affiliate' },
      { kind: 'soon', label: 'Build' },
    ],
  },
];

// Prefer the grouped display label (e.g. personal → "Finances") over the raw
// workspace label, falling back to the workspace's own label.
function displayLabel(ws: Workspace): string {
  for (const g of GROUPS) {
    for (const it of g.items) {
      if (it.kind === 'workspace' && it.key === ws.key && it.label) return it.label;
    }
  }
  return ws.label;
}

export function WorkspaceSwitcher({
  current,
  accessible,
  collapsed,
  enterprises,
  currentEnterpriseId,
  switchAction,
  optionsEndpoint,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [loadedOptions, setLoadedOptions] = useState<Workspace[] | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const visibleOptions = loadedOptions ?? accessible;

  useEffect(() => {
    const onClickOut = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOut);
    return () => document.removeEventListener('mousedown', onClickOut);
  }, []);

  const currentWs = visibleOptions.find((w) => w.key === current) ?? visibleOptions[0];
  const showEnterpriseList =
    current === 'enterprise' && enterprises && enterprises.length > 1 && switchAction;

  const switchTo = (ws: Workspace) => {
    setOpen(false);
    if (ws.key === current) return;
    startTransition(() => {
      router.push(ws.href);
    });
  };

  const toggleOpen = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!optionsEndpoint || loadedOptions || optionsLoading) return;

    setOptionsLoading(true);
    setOptionsError(false);
    try {
      const response = await fetch(optionsEndpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('workspace options request failed');
      const payload = (await response.json()) as { workspaces?: Workspace[] };
      if (!Array.isArray(payload.workspaces) || payload.workspaces.length === 0) {
        throw new Error('workspace options response invalid');
      }
      setLoadedOptions(payload.workspaces);
    } catch {
      setOptionsError(true);
    } finally {
      setOptionsLoading(false);
    }
  };

  const selectEnterprise = (id: string) => {
    if (!switchAction) return;
    if (id === currentEnterpriseId) {
      setOpen(false);
      return;
    }
    setOpen(false);
    const fd = new FormData();
    fd.set('enterpriseId', id);
    startTransition(async () => {
      await switchAction(fd);
      router.push('/enterprise/dashboard');
      router.refresh();
    });
  };

  const renderMenu = (anchorClass: string) => (
    <div role="menu" className={`${anchorClass} z-30 w-56 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950`}>
      {optionsLoading && (
        <div role="status" className="px-3 py-2 text-xs text-zinc-500">Loading workspaces…</div>
      )}
      {optionsError && (
        <div role="alert" className="px-3 py-2 text-xs text-red-600 dark:text-red-400">Unable to load workspaces. Close and retry.</div>
      )}
      {GROUPS.map((group, gi) => {
        const rows = group.items
          .map((it) => {
            if (it.kind === 'soon') return { type: 'soon' as const, label: it.label };
            const ws = visibleOptions.find((w) => w.key === it.key);
            if (!ws) return null;
            return { type: 'ws' as const, ws, label: it.label ?? ws.label };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        if (rows.length === 0) return null;

        return (
          <div key={group.title} className={gi > 0 ? 'mt-1 border-t border-zinc-100 pt-1 dark:border-zinc-800/60' : ''}>
            <div className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${group.tintClass} ${group.headerClass}`}>
              {group.title}
            </div>
            {rows.map((row) =>
              row.type === 'ws' ? (
                <button
                  key={row.ws.key}
                  type="button"
                  onClick={() => switchTo(row.ws)}
                  role="menuitem"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                    row.ws.key === current ? 'bg-zinc-50 dark:bg-zinc-900' : ''
                  }`}
                >
                  <span className="text-zinc-500">{ICON[row.ws.key]}</span>
                  <span className="flex-1 truncate">{row.label}</span>
                  {row.ws.key === current && <CheckIcon />}
                </button>
              ) : (
                <div
                  key={`soon-${row.label}`}
                  role="menuitem"
                  aria-disabled="true"
                  className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left text-sm text-zinc-400 dark:text-zinc-600"
                >
                  <span className="text-zinc-300 dark:text-zinc-700"><SoonIcon /></span>
                  <span className="flex-1 truncate">{row.label}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                    Soon
                  </span>
                </div>
              )
            )}
          </div>
        );
      })}

      {showEnterpriseList && (
        <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-800">
          <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Switch enterprise
          </div>
          {enterprises!.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => selectEnterprise(e.id)}
              role="menuitem"
              disabled={pending}
              className={`flex w-full items-center gap-2 px-3 py-2 pl-6 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-900 ${
                e.id === currentEnterpriseId ? 'bg-zinc-50 dark:bg-zinc-900' : ''
              }`}
            >
              <span className="text-zinc-500"><BuildingIcon /></span>
              <span className="flex-1 truncate">{e.name}</span>
              {e.id === currentEnterpriseId && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          onClick={() => void toggleOpen()}
          disabled={pending}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Workspace: ${currentWs ? displayLabel(currentWs) : 'Accounting'}`}
          title={currentWs ? displayLabel(currentWs) : 'Accounting'}
          className="flex h-9 w-full items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {ICON[currentWs?.key ?? 'main']}
        </button>
        {open && renderMenu('absolute left-full top-0 ml-2')}
      </div>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => void toggleOpen()}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-zinc-500">{ICON[currentWs?.key ?? 'main']}</span>
          <span className="truncate">{currentWs ? displayLabel(currentWs) : 'Accounting'}</span>
        </span>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && renderMenu('absolute left-0 right-0 top-full mt-1 w-auto')}
    </div>
  );
}
