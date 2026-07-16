'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { assertNotDemo } from '@/lib/auth/demo';
import { restoreDuplicate } from '@/lib/audit/dedupe';
import { recordFirmChange } from '@/lib/enterprise/attribution';

/**
 * Restore a quarantined duplicate from the "Removed duplicates" bucket back to
 * the active ledger. The row returns UNPOSTED (its reversed JE is not re-created)
 * so the normal categorize/post flow re-books it deliberately.
 */
export async function restoreDuplicateTransactionAction(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'restore transactions');
  const transactionId = String(formData.get('transactionId') ?? '').trim();
  if (!transactionId) return;

  const ok = await restoreDuplicate({ organizationId: orgId, transactionId });
  if (ok) {
    await recordFirmChange({
      action: 'restore_duplicate',
      orgId,
      entityType: 'transaction',
      entityId: transactionId,
      summary: 'Restored a transaction from the Removed-duplicates bucket',
    });
  }
  revalidatePath('/transactions');
}
