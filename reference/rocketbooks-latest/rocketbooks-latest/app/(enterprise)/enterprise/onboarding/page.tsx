import { notFound } from 'next/navigation';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { getEnterpriseOnboardingStatus } from '@/lib/enterprise/onboarding';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { firmHasPaymentMethod, firmPrivateLabelActive } from '@/lib/stripe/firm-billing';
import { countFirmPaidClients } from '@/lib/enterprise/client-billing';
import { PRIVATE_LABEL_ROOT } from '@/lib/enterprise/subdomain';
import { AdminPage } from '@/components/admin/AdminPage';
import { EnterpriseOnboardingWizard } from '../_components/EnterpriseOnboardingWizard';
import { EnterpriseOnboardingWalkthrough } from '../_components/EnterpriseOnboardingWalkthrough';

export const dynamic = 'force-dynamic';

export default async function EnterpriseOnboardingPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const status = await getEnterpriseOnboardingStatus(current.id);

  // What needs paying at the Review step + whether it's done yet.
  const isDemo = current.id === DEMO_ENTERPRISE_ID;
  const privateLabelEnabled = !!status.answers.privateLabelEnabled;
  // Count the clients the firm actually pays for (handles "varies" firms, which
  // the firm-level mode alone misses). firmPays drives the billing prompt.
  const firmPaidClientCount = isDemo ? 0 : await countFirmPaidClients(current.id);
  const firmPays = status.answers.clientBillingMode === 'firm_pays' || firmPaidClientCount > 0;
  const needsBilling = !isDemo && (privateLabelEnabled || firmPays);
  const cardOnFile = needsBilling ? await firmHasPaymentMethod(current.id) : false;
  const privateLabelActive = needsBilling && privateLabelEnabled ? await firmPrivateLabelActive(current.id) : false;

  return (
    <AdminPage title="Set up your firm" crumbs={[{ label: 'Enterprise' }, { label: 'Set up your firm' }]}>
      <EnterpriseOnboardingWalkthrough phase={status.phase} privateLabelEnabled={privateLabelEnabled} />
      <EnterpriseOnboardingWizard
        initial={status}
        billing={{ needsBilling, privateLabelEnabled, firmPays, cardOnFile, privateLabelActive, firmPaidClientCount }}
        subdomainRoot={PRIVATE_LABEL_ROOT}
      />
    </AdminPage>
  );
}
