'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { AccessibleOrg } from '@/lib/auth/org';
import { DEMO_ORG_ID } from '@/lib/auth/demo';
import { addBusinessAction } from '@/app/(app)/businesses/_actions/addBusiness';
import {
  blockDocumentForOrganizationSwitch,
  replaceDocumentAfterOrganizationSwitch,
  unblockDocumentAfterOrganizationSwitchFailure,
} from '@/lib/auth/org-switch-client';

interface Props {
  current: { id: string; name: string };
  options: AccessibleOrg[];
}

export function OrgSwitcher({ current, options }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hydratedCurrent, setHydratedCurrent] = useState<{ id: string; name: string } | null>(null);
  const [optionsState, setOptionsState] = useState<AccessibleOrg[]>(options);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const loadedOptionsRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const visibleCurrent = hydratedCurrent ?? current;


  useEffect(() => {
    const onClickOut = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOut);
    return () => document.removeEventListener('mousedown', onClickOut);
  }, []);

  useEffect(() => {
    if (loadedOptionsRef.current || (!open && visibleCurrent.name !== 'Workspace')) return;
    let cancelled = false;
    setLoadingOptions(true);
    fetch('/api/orgs/options', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed to load businesses'))))
      .then((data: { currentOrg?: { id: string; name: string } | null; orgs?: AccessibleOrg[] }) => {
        if (cancelled) return;
        const fetched = data.orgs ?? [];
        if (data.currentOrg) setHydratedCurrent(data.currentOrg);
        setOptionsState(fetched.some((o) => o.id === current.id) ? fetched : [{ ...current, role: 'primary' as const }, ...fetched]);
        loadedOptionsRef.current = true;
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load businesses');
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, current, visibleCurrent.name]);

  const switchTo = (orgId: string) => {
    if (orgId === visibleCurrent.id) {
      setOpen(false);
      return;
    }
    setError(null);
    blockDocumentForOrganizationSwitch();
    startTransition(async () => {
      let r: Response;
      try {
        r = await fetch('/api/orgs/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId }),
        });
      } catch {
        unblockDocumentAfterOrganizationSwitchFailure();
        setError('Failed to switch');
        return;
      }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        unblockDocumentAfterOrganizationSwitchFailure();
        setError(e.error ?? 'Failed to switch');
        return;
      }
      setOpen(false);
      replaceDocumentAfterOrganizationSwitch();
    });
  };

  const addBusiness = () => {
    setError(null);
    startTransition(async () => {
      const r = await addBusinessAction();
      if (!r.ok || !r.redirectTo) {
        setError(r.error ?? 'Failed to create business');
        return;
      }
      setOpen(false);
      if (r.redirectTo.startsWith('http')) {
        window.location.assign(r.redirectTo);
      } else {
        router.push(r.redirectTo);
      }
    });
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
      >
        <span className="max-w-[180px] truncate">{visibleCurrent.name}</span>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {loadingOptions && (
              <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">Loading businesses…</div>
            )}
            {optionsState.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => switchTo(o.id)}
                role="menuitem"
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                  o.id === visibleCurrent.id ? 'bg-zinc-50 dark:bg-zinc-900' : ''
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="flex items-center gap-2 text-xs text-zinc-500">
                  {o.role !== 'owner' && <span>{o.role}</span>}
                  {o.id === visibleCurrent.id && (
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="flex flex-col border-t border-zinc-200 p-1 dark:border-zinc-800">
            <button
              type="button"
              onClick={addBusiness}
              disabled={pending}
              role="menuitem"
              className="flex items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{pending ? 'Creating…' : 'Add business'}</span>
            </button>
            <Link
              prefetch={false}
              href="/businesses"
              onClick={() => setOpen(false)}
              className="block rounded px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              View all businesses →
            </Link>
            <button
              type="button"
              onClick={() => switchTo(DEMO_ORG_ID)}
              disabled={pending}
              role="menuitem"
              className={`flex items-center justify-between gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
                visibleCurrent.id === DEMO_ORG_ID
                  ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
                  : 'text-zinc-700 hover:bg-amber-50 hover:text-amber-800 dark:text-zinc-300 dark:hover:bg-amber-950/40 dark:hover:text-amber-200'
              }`}
              title="Switch into the read-only sample workspace"
            >
              <span className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>View demo workspace</span>
              </span>
              {visibleCurrent.id === DEMO_ORG_ID && (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
