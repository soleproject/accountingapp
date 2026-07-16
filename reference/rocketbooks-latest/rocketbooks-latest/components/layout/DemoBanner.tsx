'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addBusinessAction } from '@/app/(app)/businesses/_actions/addBusiness';
import { dismissDemoBannerAction } from '@/app/(app)/_actions/demo-banner';

/**
 * Banner shown while the user is browsing the read-only demo workspace.
 * "Create your workspace" follows the same path as OrgSwitcher's "+ Add
 * business": create a fresh org via addBusinessAction (which swaps the
 * active org cookie + user.activeOrganizationId server-side) and then
 * route to /ai-chat?welcome=fresh so the text-only onboarding kicks off.
 */
export function DemoBanner() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const createWorkspace = () => {
    setError(null);
    startTransition(async () => {
      const r = await addBusinessAction();
      if (!r.ok || !r.redirectTo) {
        setError(r.error ?? 'Failed to create workspace');
        return;
      }
      if (r.redirectTo.startsWith('http')) {
        window.location.assign(r.redirectTo);
      } else {
        router.push(r.redirectTo);
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2.5 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          <span className="font-semibold">You&apos;re in the demo workspace.</span>{' '}
          This is sample data — create a workspace to use your own.
        </span>
        {error && <span className="ml-2 text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={createWorkspace}
          disabled={pending}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-amber-700 disabled:opacity-60"
        >
          {pending ? 'Creating…' : 'Create your workspace →'}
        </button>
        <form action={dismissDemoBannerAction}>
          <button
            type="submit"
            aria-label="Dismiss banner"
            title="Dismiss for this session — Create workspace stays in the top bar"
            className="rounded-md p-1.5 text-amber-900/70 hover:bg-amber-900/10 hover:text-amber-900 dark:text-amber-200/70 dark:hover:bg-amber-200/10 dark:hover:text-amber-200"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
