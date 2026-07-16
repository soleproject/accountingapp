'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { listEnterpriseClientOrgIds } from '@/lib/enterprise/review-accountability';
import { sendClientReviewRequest } from '@/lib/accounting/review-outreach';

/**
 * Firm-triggered "ask this client to answer their pending reviews". Verifies the
 * target org is actually one of the current enterprise's clients before sending
 * (so a firm can only nudge its own clients). Cooldown-guarded in the lib.
 */
export async function requestClientReviewForOrg(formData: FormData): Promise<void> {
  const enterprise = await getCurrentEnterprise();
  if (!enterprise) return;

  const orgId = String(formData.get('orgId') ?? '');
  if (!orgId) return;

  const clientOrgIds = await listEnterpriseClientOrgIds(enterprise.id);
  if (!clientOrgIds.includes(orgId)) return; // not this firm's client — refuse

  const userId = await getEffectiveUserId();
  await sendClientReviewRequest({ orgId, triggeredByUserId: userId });
  revalidatePath('/enterprise/review-accountability');
}
