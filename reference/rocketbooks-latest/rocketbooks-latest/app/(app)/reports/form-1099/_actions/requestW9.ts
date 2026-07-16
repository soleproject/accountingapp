'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { sendW9Request, sendW9RequestsForEligible } from '@/lib/accounting/w9-outreach';

const ACCOUNTANT = ['accounting.transactions.accountant_review', 'enterprise.dashboard.view', 'enterprise.clients.view'];

/** Email one vendor for their W-9. Accountant-gated. */
export async function requestW9(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(ACCOUNTANT))) return;
  const contactId = String(formData.get('contactId') ?? '').trim();
  if (!contactId) return;
  await sendW9Request({ orgId, contactId });
  revalidatePath('/reports/form-1099');
}

/** Email every 1099-eligible vendor (with an email, not yet on file) for their W-9. */
export async function requestAllW9(): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(ACCOUNTANT))) return;
  await sendW9RequestsForEligible(orgId);
  revalidatePath('/reports/form-1099');
}
