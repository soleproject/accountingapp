import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { OrganizerSidebar } from '@/components/layout/OrganizerSidebar';
import { TopBar } from '@/components/layout/TopBar';
import { TRIAL_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/trial-banner-constants';
import { DEMO_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/demo-banner-constants';
import { DemoBanner } from '@/components/layout/DemoBanner';
import { DemoTrialBanner } from '@/components/demo/DemoTrialBanner';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { BillingStatusBanner } from '@/components/billing/BillingStatusBanner';
import { getImpersonatedUser } from '@/lib/auth/impersonate';
import { AssistantProvider } from '@/components/ai-assistant/AssistantContext';
import { AIAssistantSidecar } from '@/components/ai-assistant/AIAssistantSidecar';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace';
import { getUserPermissions } from '@/lib/auth/permissions';
import { getEnterpriseBranding } from '@/lib/auth/enterpriseBranding';
import { isDemoOrg } from '@/lib/auth/demo';
import { getDemoTrialState, getOrgTrialState } from '@/lib/billing/demo-trial';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { isTextsEnabled } from '@/lib/texts/access';
import { logger } from '@/lib/logger';

async function loadOrganizerFeatureFlags(userId: string, orgId: string, demo: boolean) {
  if (demo) return { recorderEnabled: true, textsEnabled: true };
  const recorderEnabled = await isRecorderEnabled(userId, orgId);
  const textsEnabled = await isTextsEnabled(userId);
  return { recorderEnabled, textsEnabled };
}

async function loadOrganizerBranding() {
  return getEnterpriseBranding();
}

export default async function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const [[org], orgs, workspaces, permissions, impersonated, demoTrial, orgTrial] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    listAccessibleOrgs(),
    listAccessibleWorkspaces(),
    getUserPermissions(),
    getImpersonatedUser(),
    getDemoTrialState(user.id),
    getOrgTrialState(orgId),
  ]);
  const branding = await loadOrganizerBranding().catch((err) => {
    const msg = err instanceof Error ? err.message : 'organizer branding failed';
    logger.error({ err: msg }, 'organizer branding degraded');
    return null;
  });

  // Pulse and AI Assistant are hidden from the organizer nav for now. Purely a
  // nav-visibility change in the organizer; does NOT affect the accounting
  // `accounting.pulse.view` / `accounting.ai_chat.view` permissions or the
  // accounting `/pulse` / `/ai-chat` pages.
  // In the shared demo org, always surface Recorder and Texts so their seeded
  // demo data is reachable, regardless of the viewer's own feature flags.
  const demo = isDemoOrg(orgId);
  const { recorderEnabled, textsEnabled } = await loadOrganizerFeatureFlags(user.id, orgId, demo).catch((err) => {
    const msg = err instanceof Error ? err.message : 'organizer feature gates failed';
    logger.error({ err: msg }, 'organizer feature gates degraded');
    return { recorderEnabled: false, textsEnabled: false };
  });
  const hiddenNavPaths = [
    '/organizer/pulse',
    '/organizer/ai-chat',
    ...(recorderEnabled || demo ? [] : ['/organizer/recorder', '/organizer/notetaker']),
    ...(textsEnabled || demo ? [] : ['/organizer/texts']),
  ];

  const trialBanner = demoTrial ?? orgTrial;

  const cookieStore = await cookies();
  const trialBannerDismissed =
    cookieStore.get(TRIAL_BANNER_DISMISSED_COOKIE)?.value === '1' &&
    trialBanner?.status === 'active';
  const isDemo = isDemoOrg(orgId);
  const demoBannerDismissed =
    isDemo && cookieStore.get(DEMO_BANNER_DISMISSED_COOKIE)?.value === '1';

  const currentOrg = org ?? { id: orgId, name: orgId };

  return (
    <AssistantProvider>
      <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <OrganizerSidebar workspaces={workspaces} permissions={permissions} branding={branding} hiddenNavPaths={hiddenNavPaths} />
        <div className="flex flex-1 flex-col">
          <TopBar
            email={user.email ?? ''}
            orgs={orgs}
            currentOrg={currentOrg}
            trialBanner={trialBanner}
            trialBannerDismissed={trialBannerDismissed}
            showCreateWorkspacePill={demoBannerDismissed}
          />
          {impersonated && (
            <ImpersonationBanner
              targetName={impersonated.fullName ?? impersonated.email}
              targetEmail={impersonated.email}
            />
          )}
          {isDemo && !demoBannerDismissed && <DemoBanner />}
          {trialBanner && !trialBannerDismissed && <DemoTrialBanner state={trialBanner} />}
          <BillingStatusBanner orgId={orgId} />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
      <AIAssistantSidecar />
    </AssistantProvider>
  );
}
