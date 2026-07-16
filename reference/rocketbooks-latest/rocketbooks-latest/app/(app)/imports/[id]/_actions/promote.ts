'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { promoteImport } from '@/lib/accounting/imported-promote';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export interface PromoteState {
  ok?: boolean;
  promoted?: number;
  skipped?: number;
  reason?: string;
  error?: string;
}

export async function promoteImportAction(
  importId: string,
  _prev: PromoteState | undefined,
): Promise<PromoteState> {
  try {
    const orgId = await getCurrentOrgId();
    const result = await promoteImport({ organizationId: orgId, importId });
    logger.info({ importId, ...result }, 'imported transactions promoted');

    if (result.promoted > 0) {
      await safeSend({
        name: 'transactions/auto-categorize.requested',
        data: { organizationId: orgId, transactionIds: result.newTransactionIds },
      });
    }

    revalidatePath(`/imports/${importId}`);
    revalidatePath('/imports');
    revalidatePath('/transactions');

    return {
      ok: true,
      promoted: result.promoted,
      skipped: result.skipped,
      reason: result.reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Promote failed';
    return { ok: false, error: msg };
  }
}
