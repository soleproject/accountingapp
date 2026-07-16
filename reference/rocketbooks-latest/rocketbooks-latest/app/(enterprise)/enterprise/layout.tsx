import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace';
import { getCurrentEnterprise, listAccessibleEnterprises, listMemberEnterprises } from '@/lib/auth/enterprise';
import { themeCssVars, type ThemeConfig } from '@/lib/enterprise/theme';
import { EnterpriseSidebar } from '@/components/layout/EnterpriseSidebar';
import { AdminTopBar } from '@/components/layout/AdminTopBar';
import { DemoTrialBanner } from '@/components/demo/DemoTrialBanner';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { getImpersonatedUser } from '@/lib/auth/impersonate';
import { getDemoTrialState } from '@/lib/billing/demo-trial';
import { AssistantProvider } from '@/components/ai-assistant/AssistantContext';
import { AIAssistantSidecar } from '@/components/ai-assistant/AIAssistantSidecar';
import { EnterpriseAssistantRegistrar } from './_components/EnterpriseAssistantRegistrar';

export default async function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();

  // Note: auto-ending an Open books / impersonation session when the firm user
  // returns to the enterprise area is handled in middleware.ts (edge), so back/
  // soft navigations resolve without a blank-page refresh.
  const enterprises = await listAccessibleEnterprises();
  if (enterprises.length === 0) redirect('/dashboard');

  const [workspaces, demoTrial, currentEnterprise, memberEnterprises, impersonated] = await Promise.all([
    listAccessibleWorkspaces(),
    getDemoTrialState(user.id),
    getCurrentEnterprise(),
    listMemberEnterprises(),
    // Super-admin impersonation is NOT auto-ended by middleware in /enterprise
    // (only "Open books" is) — it relies on this banner's Stop button. Without
    // it a super admin who impersonates an enterprise user has no way out.
    getImpersonatedUser(),
  ]);
  if (!currentEnterprise) redirect('/dashboard');

  // The switcher shows only enterprises the user is actually a member of
  // (owner/staff). Super-admin omniscience does NOT add rows here — for
  // viewing arbitrary enterprises, use the super-admin → impersonate flow.
  const enterpriseChoices = memberEnterprises.map((e) => ({ id: e.id, name: e.name }));

  // White-label Theme Studio: a brand color seeds the accent tokens; themeConfig
  // overrides any token. Applied only for private-label firms. The virtual demo
  // enterprise has no org row — use a showcase theme.
  // The virtual demo enterprise has no org row, so this query returns nothing
  // and it falls back to the default RocketBooks (multi-color) theme — same as
  // any un-themed (Regular) enterprise.
  const [o] = await db
    .select({
      pl: organizations.privateLabelEnabled,
      color: organizations.brandColorHex,
      theme: organizations.themeConfig,
    })
    .from(organizations)
    .where(eq(organizations.id, currentEnterprise.id))
    .limit(1);
  const privateLabel = !!o?.pl;
  const brandColor = o?.color ?? null;
  const themeConfig = (o?.theme as ThemeConfig | null) ?? null;
  const effectiveTheme: ThemeConfig = {
    ...(brandColor ? { accentBtn: brandColor, accentLink: brandColor, accentCheckbox: brandColor, accentRing: brandColor } : {}),
    ...(themeConfig ?? {}),
  };
  const styleVars = themeCssVars(effectiveTheme);
  const themed = privateLabel && Object.keys(styleVars).length > 0;

  return (
    <AssistantProvider>
      <EnterpriseAssistantRegistrar />
      <div
        className={`flex min-h-screen bg-zinc-50 dark:bg-zinc-950${themed ? ' rs-themed' : ''}`}
        style={themed ? (styleVars as React.CSSProperties) : undefined}
      >
        <EnterpriseSidebar
          workspaces={workspaces}
          enterpriseName={currentEnterprise.name}
          enterprises={enterpriseChoices}
          currentEnterpriseId={currentEnterprise.id}
        />
        <div className="flex flex-1 flex-col">
          <AdminTopBar email={user.email ?? ''} title={currentEnterprise.name} />
          {impersonated && (
            <ImpersonationBanner
              targetName={impersonated.fullName ?? impersonated.email}
              targetEmail={impersonated.email}
            />
          )}
          {demoTrial && <DemoTrialBanner state={demoTrial} />}
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
      <AIAssistantSidecar />
    </AssistantProvider>
  );
}
