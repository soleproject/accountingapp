import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { TaxesSidebar } from '@/components/layout/TaxesSidebar';
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
import { TaxAssistantRegistrar } from './_components/TaxAssistantRegistrar';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace';
import { getUserPermissions } from '@/lib/auth/permissions';
import { getEnterpriseBranding } from '@/lib/auth/enterpriseBranding';
import { isDemoOrg } from '@/lib/auth/demo';
import { getDemoTrialState, getOrgTrialState } from '@/lib/billing/demo-trial';

export default async function TaxesLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const [[org], orgs, workspaces, permissions, branding, impersonated, demoTrial, orgTrial] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    listAccessibleOrgs(),
    listAccessibleWorkspaces(),
    getUserPermissions(),
    getEnterpriseBranding(),
    getImpersonatedUser(),
    getDemoTrialState(user.id),
    getOrgTrialState(orgId),
  ]);

  const trialBanner = demoTrial ?? orgTrial;

  const cookieStore = await cookies();
  const trialBannerDismissed =
    cookieStore.get(TRIAL_BANNER_DISMISSED_COOKIE)?.value === '1' && trialBanner?.status === 'active';
  const isDemo = isDemoOrg(orgId);
  const demoBannerDismissed = isDemo && cookieStore.get(DEMO_BANNER_DISMISSED_COOKIE)?.value === '1';

  const currentOrg = org ?? { id: orgId, name: orgId };

  return (
    <AssistantProvider>
      <TaxAssistantRegistrar />
      <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <TaxesSidebar workspaces={workspaces} permissions={permissions} branding={branding} />
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
