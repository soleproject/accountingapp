import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage } from '@/components/admin/AdminPage';
import { BulkClientImport } from '../../_components/BulkClientImport';
import type { WelcomeEmailConfig } from '../../_components/WelcomeEmailEditor';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';

export const dynamic = 'force-dynamic';

export default async function ImportClientsPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const [orgRow] = await db
    .select({
      billingMode: organizations.clientBillingMode,
      priceMode: organizations.clientPriceMode,
      handoff: organizations.clientOnboardingHandoff,
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
    .limit(1);
  const firmHasCard = await firmHasPaymentMethod(current.id);

  return (
    <AdminPage
      title="Import clients"
      crumbs={[{ label: 'Enterprise' }, { label: 'Clients', href: '/enterprise/clients' }, { label: 'Import' }]}
    >
      <BulkClientImport
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
    </AdminPage>
  );
}
