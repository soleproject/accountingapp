import Link from 'next/link';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { db } from '@/db/client';
import { onboardingState, users } from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DashboardSummaryClient } from './_components/DashboardSummaryClient';
import { loadDashboardSummary } from './_lib/loadDashboardSummary';
import { DashboardWelcome } from './_components/DashboardWelcome';
import { TourPickerHost } from './_components/TourPickerHost';
import { InsightsDashboard } from './_components/InsightsDashboard';

/** Cookie the TopBar dashboard toggle flips: 'insights' = the graph/posture
 *  command center; anything else (default) = the company-snapshot summary. */
export const DASH_VIEW_COOKIE = 'rs_dash_view';

export const dynamic = 'force-dynamic';

function firstNameFrom(fullName: string | null | undefined, email: string): string {
  if (fullName && fullName.trim()) return fullName.trim().split(/\s+/)[0];
  const local = email.split('@')[0] ?? '';
  if (!local) return '';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

interface PageProps {
  searchParams: Promise<{ welcome?: string; tour?: string }>;
}

const workAreas = [
  { href: '/reports', label: 'Reports', description: 'Balance sheet, income statement, cash flow, and ledgers.' },
  { href: '/invoices', label: 'Invoices', description: 'Create invoices and follow up on money coming in.' },
  { href: '/bills', label: 'Bills', description: 'Track vendor bills and what needs to be paid.' },
  { href: '/contacts', label: 'Contacts', description: 'Manage customers, vendors, and transaction relationships.' },
  { href: '/chart-of-accounts', label: 'Chart of Accounts', description: 'Review account structure and accounting mappings.' },
  { href: '/settings', label: 'Settings', description: 'Company profile, method, workspace, and operating preferences.' },
];

const operatingRhythm = [
  'Connect accounts and imports',
  'Review what RocketSuite categorized',
  'Send invoices or pay bills',
  'Open reports when the work is clean',
];

type DashboardGate = {
  profile: {
    fullName: string | null;
    email: string | null;
    welcomeDismissedAt: Date | string | null;
    orgId: string | null;
    activeOrgId: string | null;
  };
  onboarding: { phase: string | null; completed: boolean | null } | null;
};

async function loadDashboardGate(fallbackEmail: string): Promise<DashboardGate> {
  const effectiveUserId = await getEffectiveUserId();
  const rows = await db
    .select({
      fullName: users.fullName,
      email: users.email,
      welcomeDismissedAt: users.welcomeDismissedAt,
      orgId: users.organizationId,
      activeOrgId: users.activeOrganizationId,
    })
    .from(users)
    .where(eq(users.id, effectiveUserId))
    .limit(1);

  const profileRow = rows[0] ?? {
    fullName: null,
    email: fallbackEmail,
    welcomeDismissedAt: new Date(0),
    orgId: null,
    activeOrgId: null,
  };
  const orgId = profileRow.activeOrgId ?? profileRow.orgId ?? null;
  const onboarding = orgId
    ? await db
        .select({ phase: onboardingState.phase, completed: onboardingState.completed })
        .from(onboardingState)
        .where(eq(onboardingState.orgId, orgId))
        .limit(1)
        .then((stateRows) => stateRows[0] ?? null)
    : null;

  return { profile: profileRow, onboarding };
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const user = await requireSession();
  const params = await searchParams;
  const displayName = user.email?.split('@')[0] ?? 'there';

  // Which dashboard to render — the TopBar toggle (dashboard-only) flips this
  // cookie. Default (unset/anything else) = the company-snapshot summary.
  const dashView = (await cookies()).get(DASH_VIEW_COOKIE)?.value;
  const insights = dashView === 'insights';
  const summaryPromise = insights
    ? null
    : getCurrentOrgId().then(async (organizationId) => ({
        organizationId,
        summary: await loadDashboardSummary(organizationId).catch((err) => {
          const msg = err instanceof Error ? err.message : 'dashboard summary failed';
          logger.error({ err: msg }, 'dashboard initial summary degraded');
          return null;
        }),
      }));

  // Keep the dashboard document path shell-first for metrics, but preserve the
  // lightweight first-run/replay welcome gate. Settings → Replay welcome clears
  // users.welcome_dismissed_at and lands here with ?welcome=fresh; new clients
  // also need the same takeover when their dismissal timestamp is still null.
  // If the small profile/onboarding gate hits transient DB/session pressure,
  // degrade to the usable dashboard shell instead of rendering a customer error
  // boundary; the explicit replay/tour query params still work when the gate is
  // healthy.
  const { profile, onboarding } = await loadDashboardGate(user.email ?? '').catch((err) => {
    const msg = err instanceof Error ? err.message : 'dashboard gate failed';
    logger.error({ err: msg }, 'dashboard first-render gate degraded');
    return {
      profile: {
        fullName: null,
        email: user.email ?? '',
        welcomeDismissedAt: new Date(0),
        orgId: null,
        activeOrgId: null,
      },
      onboarding: null,
    } satisfies DashboardGate;
  });
  const showTourPicker = params.tour === 'pick';
  const showWelcome = !showTourPicker && (params.welcome === 'fresh' || !profile?.welcomeDismissedAt);
  const showOnboardingPrompt = !showWelcome && !showTourPicker && onboarding != null && !onboarding.completed;
  const firstName = firstNameFrom(profile?.fullName, profile?.email ?? user.email ?? '');

  const initial = await summaryPromise;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {showTourPicker && <TourPickerHost firstName={firstName} />}
      {!showTourPicker && showWelcome && <DashboardWelcome firstName={firstName} />}
      {showOnboardingPrompt && (
        <section className="rounded-3xl border border-blue-200 bg-blue-50 p-5 shadow-sm dark:border-blue-900/60 dark:bg-blue-950/30 sm:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-300">Guided onboarding</p>
              <h2 className="mt-1 text-2xl font-semibold text-zinc-950 dark:text-white">Finish setting up this company</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                Your setup is still in progress. Continue the guided assistant flow to finish the current onboarding step and get the dashboard fully tuned for this organization.
              </p>
            </div>
            <Link
              prefetch={false}
              href="/ai-chat?onboarding=start"
              className="inline-flex shrink-0 items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
            >
              Continue onboarding
            </Link>
          </div>
        </section>
      )}
      {insights ? (
        <InsightsDashboard />
      ) : (
        <>
      <section className="overflow-hidden rounded-3xl border border-white/70 bg-white/90 shadow-xl shadow-blue-950/5 backdrop-blur dark:border-white/10 dark:bg-zinc-950/80 dark:shadow-black/30">
        <div className="grid gap-0 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="p-6 sm:p-8 lg:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
              Accounting summary
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-5xl">
              Welcome back, {displayName}. Here&apos;s the company snapshot.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
              See cash activity, outstanding invoices, outstanding bills, and the transaction cleanup queue before opening a work area.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                prefetch={false}
                href="/transactions"
                className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
              >
                Review transactions
              </Link>
              <Link
                prefetch={false}
                href="/integrations/plaid"
                className="rounded-xl border border-zinc-300 bg-white px-5 py-3 text-sm font-semibold text-zinc-800 transition hover:border-blue-300 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-blue-700 dark:hover:text-blue-300"
              >
                Connect accounts
              </Link>
              <Link
                prefetch={false}
                href="/reports"
                className="rounded-xl border border-zinc-300 bg-white px-5 py-3 text-sm font-semibold text-zinc-800 transition hover:border-blue-300 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-blue-700 dark:hover:text-blue-300"
              >
                View reports
              </Link>
            </div>
          </div>

          <aside className="border-t border-zinc-200 bg-zinc-950 p-6 text-white dark:border-zinc-800 lg:border-l lg:border-t-0 lg:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">Today&apos;s rhythm</p>
            <ol className="mt-5 space-y-4">
              {operatingRhythm.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="pt-1 text-sm leading-5 text-zinc-200">{step}</span>
                </li>
              ))}
            </ol>
            <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-white">Need the fastest path?</p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">
                If something looks stuck, go straight to Billing for import unlocks or Transactions for review work.
              </p>
            </div>
          </aside>
        </div>
      </section>

      <DashboardSummaryClient key={initial!.organizationId} initialSummary={initial!.summary} />

      <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Workspace</p>
            <h2 className="mt-1 text-2xl font-semibold">Open a work area</h2>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            This command center is intentionally lightweight so it loads quickly while richer metrics are rebuilt behind performance gates.
          </p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workAreas.map((area) => (
            <Link
              prefetch={false}
              key={area.href}
              href={area.href}
              className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 transition hover:border-blue-300 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
            >
              <div className="font-semibold text-zinc-950 dark:text-white">{area.label}</div>
              <p className="mt-1 text-sm leading-5 text-zinc-600 dark:text-zinc-300">{area.description}</p>
            </Link>
          ))}
        </div>
      </section>
        </>
      )}
    </div>
  );
}
