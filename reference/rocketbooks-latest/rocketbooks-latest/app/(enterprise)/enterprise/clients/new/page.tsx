import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { permissionSets, users, enterpriseClients, organizations } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { requireSession } from '@/lib/auth/session';
import { CreateEnterpriseUserForm } from '../../_components/CreateEnterpriseUserForm';
import type { WelcomeEmailConfig } from '../../_components/WelcomeEmailEditor';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';

export const dynamic = 'force-dynamic';

export default async function NewEnterpriseUserPage() {
  const sessionUser = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const [permSets, [actor], [orgRow], firmHasCard] = await Promise.all([
    db
      .select({ id: permissionSets.id, name: permissionSets.name })
      .from(permissionSets)
      .orderBy(asc(permissionSets.name)),
    db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1),
    db
      .select({
        billingMode: organizations.clientBillingMode,
        priceMode: organizations.clientPriceMode,
        privateLabel: organizations.privateLabelEnabled,
        logoUrl: organizations.logoUrl,
        name: organizations.name,
        brandColor: organizations.brandColorHex,
        aiName: organizations.aiAssistantName,
        bookingUrl: organizations.clientBookingUrl,
        welcomeEmailConfig: organizations.welcomeEmailConfig,
        welcomeEmailConfigSwitching: organizations.welcomeEmailConfigSwitching,
      })
      .from(organizations)
      .where(eq(organizations.id, current.id))
      .limit(1),
    firmHasPaymentMethod(current.id),
  ]);
  const isDemoOwner = actor?.role === 'enterprise_owner_demo';

  // Cap check at page level so the demo owner sees a clear "limit reached"
  // panel instead of filling out the form and hitting the action's
  // hard-throw (which Next.js renders as a generic 500 page).
  if (isDemoOwner) {
    const [existingClient] = await db
      .select({ id: enterpriseClients.id })
      .from(enterpriseClients)
      .where(eq(enterpriseClients.enterpriseId, current.id))
      .limit(1);
    if (existingClient) {
      return (
        <AdminPage
          title="Create User"
          crumbs={[
            { label: 'Enterprise', href: '/enterprise/dashboard' },
            { label: 'Clients', href: '/enterprise/clients' },
            { label: 'Create User' },
          ]}
        >
          <Panel>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-6 dark:border-amber-900/60 dark:bg-amber-950/30">
              <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
                Demo client limit reached
              </h2>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                Your demo trial is capped at 1 client. Upgrade to add more clients -- all your existing data carries over.
              </p>
              <Link
                href="/billing"
                className="mt-4 inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
              >
                Upgrade →
              </Link>
            </div>
          </Panel>
        </AdminPage>
      );
    }
  }

  // Enterprise users can only create Paying User / Enterprise Owner /
  // Enterprise Staff. Only show permission sets that match those roles —
  // the action layer also rejects anything else, so this is purely UI.
  // Order matches the workflow frequency: paying-user creation is the
  // common case, staff next, owner last.
  const ORDER = ['paying user', 'enterprise staff', 'enterprise owner'];
  const assignablePermSets = ORDER.flatMap((label) => {
    const match = permSets.find((p) => p.name.toLowerCase() === label);
    return match ? [match] : [];
  });

  return (
    <AdminPage
      title="Create User"
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Clients', href: '/enterprise/clients' },
        { label: 'Create User' },
      ]}
    >
      <Panel>
        <CreateEnterpriseUserForm
          permissionSets={assignablePermSets}
          enterpriseId={current.id}
          enterpriseName={current.name}
          isDemoOwner={isDemoOwner}
          clientBillingMode={orgRow?.billingMode ?? null}
          clientPriceMode={orgRow?.priceMode ?? null}
          privateLabelEnabled={orgRow?.privateLabel ?? false}
          logoUrl={orgRow?.logoUrl ?? null}
          firmName={orgRow?.name ?? 'your firm'}
          brandColor={orgRow?.brandColor ?? '#2563eb'}
          aiName={orgRow?.aiName ?? 'your assistant'}
          firmBookingUrl={orgRow?.bookingUrl ?? ''}
          firmWelcomeEmailConfig={(orgRow?.welcomeEmailConfig as WelcomeEmailConfig | null) ?? null}
          firmWelcomeEmailConfigSwitching={(orgRow?.welcomeEmailConfigSwitching as WelcomeEmailConfig | null) ?? null}
          firmHasCard={firmHasCard}
        />
      </Panel>
    </AdminPage>
  );
}
