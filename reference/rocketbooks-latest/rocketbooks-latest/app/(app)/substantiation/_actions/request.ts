'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { assertNotDemo } from '@/lib/auth/demo';
import { sendSubstantiationRequest } from '@/lib/accounting/substantiation-outreach';

const ACCOUNTANT_KEYS = [
  'accounting.transactions.accountant_review',
  'enterprise.dashboard.view',
  'enterprise.clients.view',
];

/** Accountant-triggered: email the client for IRS documentation on recent substantiation-required txns. */
export async function requestSubstantiationAction(_formData?: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'request substantiation documentation');
  if (!(await hasAnyPermission(ACCOUNTANT_KEYS))) return;
  await getEffectiveUserId();
  await sendSubstantiationRequest({ orgId, days: 7 });
  revalidatePath('/substantiation');
}
