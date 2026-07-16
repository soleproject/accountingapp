'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { assertNotDemo } from '@/lib/auth/demo';
import { categorizeTransaction } from '@/lib/accounting/categorize';
import { logger } from '@/lib/logger';

export interface BulkResult {
  ok?: boolean;
  error?: string;
  posted?: number;
  skipped?: number;
}

/**
 * UI server action: categorize many transactions to one account in one click.
 * The single-transaction logic lives in lib/accounting/categorize.ts so the
 * AI's categorize_transaction tool can share the same code path.
 *
 * "posted" counts new JEs created; "skipped" counts transactions whose JE
 * already existed (we just retagged) plus failures. The UI's existing
 * "X posted, Y skipped" message keeps its meaning.
 */
export async function bulkCategorize(
  _prev: BulkResult | undefined,
  formData: FormData,
): Promise<BulkResult | undefined> {
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'categorize transactions');
  const ids = formData.getAll('ids').map(String).filter(Boolean);
  const categoryAccountId = String(formData.get('categoryAccountId') ?? '');

  if (ids.length === 0) return { error: 'No transactions selected' };
  if (!categoryAccountId) return { error: 'Pick a category account' };

  // Fail-fast org-scope check so the whole batch shares one error response if
  // the account is bogus, rather than N identical per-row errors.
  const [account] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.id, categoryAccountId), eq(chartOfAccounts.organizationId, orgId)),
    )
    .limit(1);
  if (!account) return { error: 'Category account not in this organization' };

  let posted = 0;
  let skipped = 0;

  for (const id of ids) {
    const result = await categorizeTransaction({
      organizationId: orgId,
      transactionId: id,
      categoryAccountId,
    });
    if (!result.ok) {
      logger.warn({ txnId: id, err: result.error }, 'bulk categorize: skip txn');
      skipped++;
    } else if (result.mode === 'posted') {
      posted++;
    } else {
      // 'updated' — already-posted txn, only the category label flipped.
      // Original implementation counted these as 'skipped'; preserve the count.
      skipped++;
    }
  }

  revalidatePath('/transactions');
  return { ok: true, posted, skipped };
}
