import Link from 'next/link';
import type { DemoTrialState } from '@/lib/billing/demo-trial';
import { dismissTrialBannerAction } from '@/app/(app)/_actions/trial-banner';

interface Props {
  state: DemoTrialState;
}

/**
 * In-app banner for the self-serve Enterprise demo trial. Distinct from
 * the existing DemoBanner (which is for the read-only view-only demo
 * workspace). Three flavors keyed by state.status:
 *   no_client -- nudge to create their one client (which starts the timer)
 *   active    -- countdown, amber. Goes red at <=1 day
 *   expired   -- read-only mode, must upgrade to continue editing
 */
export function DemoTrialBanner({ state }: Props) {
  if (state.status === 'no_client') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sky-300 bg-sky-50 px-6 py-2.5 text-sm dark:border-sky-900/60 dark:bg-sky-950/30">
        <div className="flex items-center gap-2 text-sky-900 dark:text-sky-200">
          <Icon />
          <span>
            <span className="font-semibold">Welcome to your demo.</span>{' '}
            Create your first client to start your 7-day trial -- you&apos;ll get full access to QuickBooks mirroring, historical imports, and more.
          </span>
        </div>
        <Link
          href="/enterprise/clients/new"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-sky-700"
        >
          Create your client →
        </Link>
      </div>
    );
  }

  if (state.status === 'expired') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-300 bg-red-50 px-6 py-2.5 text-sm dark:border-red-900/60 dark:bg-red-950/30">
        <div className="flex items-center gap-2 text-red-900 dark:text-red-200">
          <Icon />
          <span>
            <span className="font-semibold">Your demo trial has ended.</span>{' '}
            Your data is preserved and the books are read-only. Upgrade to keep editing, mirror QuickBooks, and export reports.
          </span>
        </div>
        <Link
          href="/billing"
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700"
        >
          Upgrade →
        </Link>
      </div>
    );
  }

  // active
  const isUrgent = state.daysLeft != null && state.daysLeft <= 1;
  const tone = isUrgent
    ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200';
  const buttonTone = isUrgent
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-amber-600 hover:bg-amber-700';

  const daysText =
    state.daysLeft == null
      ? 'still active'
      : state.daysLeft === 1
        ? '1 day left'
        : `${state.daysLeft} days left`;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-6 py-2.5 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon />
        <span>
          <span className="font-semibold">Demo trial: {daysText}.</span>{' '}
          Upgrade any time -- all your data carries over.
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Link
          href="/billing"
          className={`rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm ${buttonTone}`}
        >
          Upgrade →
        </Link>
        <form action={dismissTrialBannerAction}>
          <button
            type="submit"
            aria-label="Dismiss banner"
            title="Dismiss for this session — Upgrade stays in the top bar"
            className="rounded-md p-1.5 text-current/70 hover:bg-current/10 hover:text-current"
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

function Icon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
