import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients, users } from '@/db/schema/schema';
import { AdminPage } from '@/components/admin/AdminPage';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';
import { AddCompanyWizard } from '../../_components/AddCompanyWizard';

export const dynamic = 'force-dynamic';

export default async function AddCompanyPage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const sp = await searchParams;
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const [firmRow] = await db
    .select({
      name: organizations.name,
      privateLabelEnabled: organizations.privateLabelEnabled,
      aiAssistantName: organizations.aiAssistantName,
      brandColorHex: organizations.brandColorHex,
      logoUrl: organizations.logoUrl,
      clientBillingMode: organizations.clientBillingMode,
      clientPriceMode: organizations.clientPriceMode,
      clientOnboardingHandoff: organizations.clientOnboardingHandoff,
      clientBookingUrl: organizations.clientBookingUrl,
      enterpriseDefaultBooksManagedBy: organizations.enterpriseDefaultBooksManagedBy,
    })
    .from(organizations)
    .where(eq(organizations.id, current.id))
    .limit(1);

  const clientRows = await db
    .select({ userId: users.id, name: users.fullName, email: users.email })
    .from(enterpriseClients)
    .innerJoin(users, eq(users.id, enterpriseClients.clientUserId))
    .where(and(eq(enterpriseClients.enterpriseId, current.id), eq(enterpriseClients.status, 'active')))
    .orderBy(desc(enterpriseClients.createdAt));

  const clients = clientRows.map((c) => ({
    userId: c.userId,
    name: c.name ?? c.email ?? 'Client',
    email: c.email ?? '',
  }));

  const hasPaymentMethod = await firmHasPaymentMethod(current.id).catch(() => false);

  const tiers = ACCOUNTING_TIER_KEYS.map((k) => {
    const t = ACCOUNTING_TIERS[k];
    return {
      key: k as string,
      label: t.label,
      standard: `$${t.priceCents / 100}/mo`,
      discounted: `$${t.reducedPriceCents / 100}/mo`,
    };
  });

  const firm = {
    enterpriseId: current.id,
    name: firmRow?.name ?? 'your firm',
    privateLabelEnabled: !!firmRow?.privateLabelEnabled,
    aiAssistantName: firmRow?.aiAssistantName ?? '',
    brandColorHex: firmRow?.brandColorHex ?? '#2563eb',
    logoUrl: firmRow?.logoUrl ?? null,
    clientBillingMode: firmRow?.clientBillingMode ?? 'client_pays',
    clientPriceMode: firmRow?.clientPriceMode ?? 'standard_referral',
    clientOnboardingHandoff: firmRow?.clientOnboardingHandoff ?? 'self',
    clientBookingUrl: firmRow?.clientBookingUrl ?? '',
    hasPaymentMethod,
    defaultBooksManagedBy: firmRow?.enterpriseDefaultBooksManagedBy ?? 'both',
  };

  const preselectedOwnerId = sp.owner && clients.some((c) => c.userId === sp.owner) ? sp.owner : null;

  return (
    <AdminPage
      title="Add a company"
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Client Businesses', href: '/enterprise/businesses' },
        { label: 'Add a company' },
      ]}
    >
      <AddCompanyWizard firm={firm} clients={clients} tiers={tiers} preselectedOwnerId={preselectedOwnerId} />
    </AdminPage>
  );
}
