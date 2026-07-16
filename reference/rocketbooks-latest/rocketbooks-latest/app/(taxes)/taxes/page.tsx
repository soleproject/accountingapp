import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { listTaxReturns } from '@/lib/tax/store';
import { TaxReturnsList } from './_components/TaxReturnsList';

/** Tax returns — the front door to the self-extending tax engine. Lists returns and
 *  starts new ones; each return opens into a workspace that crawls + fills its forms. */
export default async function TaxReturnsPage() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const returns = await listTaxReturns(orgId);
  const currentYear = new Date().getFullYear();
  return <TaxReturnsList returns={returns} defaultYear={currentYear - 1} />;
}
