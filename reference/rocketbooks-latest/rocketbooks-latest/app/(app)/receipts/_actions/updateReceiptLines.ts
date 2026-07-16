'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptLines, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';

export interface UpdateReceiptLinesState {
  error?: string;
}

/**
 * Persist per-line account assignments + the receipt's source (paid-from)
 * account. Used by the categorization editor on /receipts/[id]. Does NOT
 * post — call postReceipt for that. Receipts can be partially-categorized
 * here (some lines blank) so users can save progress mid-review.
 */
export async function updateReceiptLines(
  _prev: UpdateReceiptLinesState | undefined,
  formData: FormData,
): Promise<UpdateReceiptLinesState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const receiptId = formData.get('receiptId');
  if (typeof receiptId !== 'string' || !receiptId) return { error: 'Missing receiptId' };

  const [r] = await db
    .select({ id: receipts.id, posted: receipts.posted })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)))
    .limit(1);
  if (!r) return { error: 'Receipt not found' };
  if (r.posted) return { error: 'Cannot edit lines on a posted receipt — delete it first (the JE will reverse)' };

  const rawSource = formData.get('sourceAccountId');
  const sourceAccountId = typeof rawSource === 'string' && rawSource ? rawSource : null;

  const lines = await db
    .select({ id: receiptLines.id })
    .from(receiptLines)
    .where(eq(receiptLines.receiptId, receiptId));

  const proposed = new Map<string, string | null>();
  for (const line of lines) {
    const v = formData.get(`line.${line.id}.accountId`);
    proposed.set(line.id, typeof v === 'string' && v ? v : null);
  }

  const wantedAccountIds = Array.from(proposed.values()).filter((v): v is string => !!v);
  if (sourceAccountId) wantedAccountIds.push(sourceAccountId);
  if (wantedAccountIds.length > 0) {
    const orgAccounts = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          inArray(chartOfAccounts.id, Array.from(new Set(wantedAccountIds))),
        ),
      );
    const orgIds = new Set(orgAccounts.map((a) => a.id));
    const missing = wantedAccountIds.find((id) => !orgIds.has(id));
    if (missing) return { error: 'One or more selected accounts are not in this organization' };
  }

  await db.transaction(async (tx) => {
    for (const [lineId, accountId] of proposed) {
      await tx
        .update(receiptLines)
        .set({ expenseAccountId: accountId })
        .where(eq(receiptLines.id, lineId));
    }
    await tx
      .update(receipts)
      .set({ sourceAccountId })
      .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)));
  });

  revalidatePath(`/receipts/${receiptId}`);
  revalidatePath('/receipts');
  return undefined;
}
