'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { saveSubstantiationFields } from '@/lib/accounting/substantiation';
import type { DocType } from '@/lib/accounting/substantiation-types';

/**
 * Save the IRS-documentation fields a user typed on the /substantiation page for
 * one transaction — the on-page equivalent of the client replying to the request
 * email. Delegates the merge + upsert to saveSubstantiationFields.
 */
export async function saveSubstantiationAction(input: {
  transactionId: string;
  docType: DocType;
  fields: Record<string, string>;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  await requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const res = await saveSubstantiationFields(orgId, input.transactionId, input.docType, input.fields ?? {});
  if (res.ok) revalidatePath('/substantiation');
  return res;
}
