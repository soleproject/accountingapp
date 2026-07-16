'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, generalLedger, journalEntries, journalEntryLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { logger } from '@/lib/logger';

export interface BulkRecategorizeResult {
  ok?: boolean;
  error?: string;
  updated?: number;
}

const Input = z.object({
  journalEntryIds: z.array(z.string().min(1)).min(1).max(500),
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
});

/**
 * Repoint journal_entry_lines (and matching general_ledger rows) from one
 * account to another, scoped to a set of journal entries. Used by the
 * income-statement drill-down to fix invoices/bills that posted to the wrong
 * income/expense account: the user picks the JEs, the page already knows the
 * "from" account (the drilled-into one), the user picks the "to" account.
 *
 * Mutates posted GL directly rather than reversing+re-posting. The
 * invoice/bill record itself isn't touched — its line items don't store an
 * accountId, only an itemId, so the JE/GL is the source of truth post-posting.
 */
export async function bulkRecategorizeJeLines(
  _prev: BulkRecategorizeResult | undefined,
  formData: FormData,
): Promise<BulkRecategorizeResult | undefined> {
  const orgId = await getCurrentOrgId();
  const parsed = Input.safeParse({
    journalEntryIds: formData.getAll('journalEntryIds').map(String).filter(Boolean),
    fromAccountId: formData.get('fromAccountId'),
    toAccountId: formData.get('toAccountId'),
  });
  if (!parsed.success) return { error: 'Pick at least one row and a target account' };
  const { journalEntryIds, fromAccountId, toAccountId } = parsed.data;

  if (fromAccountId === toAccountId) return { error: 'Target account is the same as the source' };

  const [fromAcct, toAcct] = await Promise.all([
    db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, fromAccountId), eq(chartOfAccounts.organizationId, orgId)))
      .limit(1),
    db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, toAccountId), eq(chartOfAccounts.organizationId, orgId)))
      .limit(1),
  ]);
  if (!fromAcct.length || !toAcct.length) return { error: 'Account not in this organization' };

  const orgJes = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(inArray(journalEntries.id, journalEntryIds), eq(journalEntries.organizationId, orgId)));
  const orgJeIds = orgJes.map((r) => r.id);
  if (!orgJeIds.length) return { error: 'No matching journal entries in this organization' };

  let updated = 0;
  try {
    await db.transaction(async (tx) => {
      const updatedLines = await tx
        .update(journalEntryLines)
        .set({ accountId: toAccountId })
        .where(
          and(
            inArray(journalEntryLines.journalEntryId, orgJeIds),
            eq(journalEntryLines.accountId, fromAccountId),
          ),
        )
        .returning({ id: journalEntryLines.id });

      const lineIds = updatedLines.map((l) => l.id);
      if (lineIds.length > 0) {
        await tx
          .update(generalLedger)
          .set({ accountId: toAccountId })
          .where(
            and(
              inArray(generalLedger.journalEntryLineId, lineIds),
              eq(generalLedger.organizationId, orgId),
              eq(generalLedger.accountId, fromAccountId),
            ),
          );
      }
      updated = lineIds.length;
    });
  } catch (err) {
    logger.error({ err }, 'bulkRecategorizeJeLines failed');
    return { error: 'Recategorize failed' };
  }

  if (updated === 0) {
    return { error: 'No lines on the selected entries hit this account' };
  }

  revalidatePath('/reports/income-statement');
  revalidatePath(`/reports/account/${fromAccountId}`);
  revalidatePath(`/reports/account/${toAccountId}`);
  return { ok: true, updated };
}
