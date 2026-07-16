import Link from 'next/link';
import { logout } from '@/app/(auth)/login/_actions/login';
import { OrgSwitcher } from './OrgSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { TourButton } from './TourButton';
import { DashboardViewToggle } from './DashboardViewToggle';
import { FeedbackButton } from '@/components/feedback/FeedbackButton';
import { CreateWorkspacePill } from './CreateWorkspacePill';
import { ImpersonationPill } from './ImpersonationPill';
import type { AccessibleOrg } from '@/lib/auth/org';
import type { DemoTrialState } from '@/lib/billing/demo-trial';
import { LanguageToggle } from '@/components/i18n/LanguageToggle';

interface Props {
  email: string;
  orgs: AccessibleOrg[];
  currentOrg: { id: string; name: string };
  trialBanner?: DemoTrialState | null;
  trialBannerDismissed?: boolean;
  showCreateWorkspacePill?: boolean;
  /** Set while impersonating AND the banner has been dismissed — renders the compact pill. */
  impersonation?: { name: string; email: string; openBooks?: boolean; companyName?: string } | null;
}

export function TopBar({ email, orgs, currentOrg, trialBanner, trialBannerDismissed, showCreateWorkspacePill, impersonation }: Props) {
  // When the in-app trial banner is dismissed, surface a small Upgrade
  // pill next to Tour so the CTA stays one click away without taking
  // banner real estate. Only renders while the trial is still active —
  // the expired-state banner is non-dismissible elsewhere.
  const showUpgradePill = trialBannerDismissed && trialBanner?.status === 'active';
  const urgent = showUpgradePill && trialBanner?.daysLeft != null && trialBanner.daysLeft <= 1;
  const pillClass = urgent
    ? 'rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-red-700'
    : 'rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-600';

  return (
    <header data-surface="topbar" className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-3 text-sm">
        <OrgSwitcher key={currentOrg.id} current={currentOrg} options={orgs} />
        <span className="text-zinc-500 dark:text-zinc-400">{email}</span>
      </div>
      <div className="flex items-center gap-3">
        {impersonation && (
          <ImpersonationPill
            targetName={impersonation.name}
            targetEmail={impersonation.email}
            openBooks={impersonation.openBooks}
            companyName={impersonation.companyName}
          />
        )}
        {showCreateWorkspacePill && <CreateWorkspacePill />}
        {showUpgradePill && (
          <Link
            prefetch={false}
            href="/billing"
            className={pillClass}
            title={
              trialBanner?.daysLeft != null
                ? `${trialBanner.daysLeft} day${trialBanner.daysLeft === 1 ? '' : 's'} left on trial`
                : 'Demo trial active'
            }
          >
            Upgrade
          </Link>
        )}
        <DashboardViewToggle />
        <TourButton />
        <FeedbackButton />
        <LanguageToggle />
        <ThemeToggle />
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
