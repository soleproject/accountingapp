'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { assertNotDemo } from '@/lib/auth/demo';
import { sendClientReviewRequest, type ReviewRequestResult } from '@/lib/accounting/review-outreach';

/**
 * Accountant-triggered "ask the client about their pending review items" nudge.
 * Emails (and texts, if opted in) the org owner with a link to the review queue.
 * Gated to accounting professionals; cooldown-guarded in the lib.
 */
export async function requestClientReview(
  _prev: ReviewRequestResult | undefined,
  _formData: FormData,
): Promise<ReviewRequestResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'send client review request');

  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  const userId = await getEffectiveUserId();
  const result = await sendClientReviewRequest({ orgId, triggeredByUserId: userId });
  revalidatePath('/transactions');
  return result;
}
