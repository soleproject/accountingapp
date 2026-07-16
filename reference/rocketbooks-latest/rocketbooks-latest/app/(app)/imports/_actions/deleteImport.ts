'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { deleteImportCascade } from '@/lib/accounting/delete-import';
import { logger } from '@/lib/logger';

export interface DeleteImportState {
  ok?: boolean;
  error?: string;
  deletedTransactions?: number;
  deletedJournalEntries?: number;
  deletedImportedTransactions?: number;
}

export async function deleteImportAction(
  importId: string,
): Promise<DeleteImportState> {
  try {
    const orgId = await getCurrentOrgId();
    const result = await deleteImportCascade({ organizationId: orgId, importId });
    logger.info(result, 'import deleted (cascade)');
    revalidatePath('/imports');
    revalidatePath(`/imports/${importId}`);
    revalidatePath('/transactions');
    return {
      ok: true,
      deletedTransactions: result.deletedTransactions,
      deletedJournalEntries: result.deletedJournalEntries,
      deletedImportedTransactions: result.deletedImportedTransactions,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}
