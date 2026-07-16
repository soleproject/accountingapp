'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { personalTransactions } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { createPersonalRule } from '@/lib/personal/categories';

const Schema = z.object({
  txnId: z.string().min(1).max(64),
  categoryName: z.string().min(1).max(120),
  applyToMerchant: z.boolean().optional(),
});

export interface RecategorizeResult {
  ok?: boolean;
  appliedCount?: number;
  error?: string;
}

/**
 * Recategorize a single personal transaction. When `applyToMerchant` is set and
 * the transaction has a merchant, also (a) create a merchant->category rule so
 * future synced transactions auto-categorize, and (b) bulk-apply the category
 * to every existing transaction from the same merchant. User-scoped throughout.
 */
export async function recategorizeAction(input: unknown): Promise<RecategorizeResult> {
  const user = await requireSession();
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  const { txnId, categoryName, applyToMerchant } = parsed.data;

  const [txn] = await db
    .select({ id: personalTransactions.id, merchant: personalTransactions.merchant })
    .from(personalTransactions)
    .where(and(eq(personalTransactions.id, txnId), eq(personalTransactions.userId, user.id)))
    .limit(1);
  if (!txn) return { error: 'Transaction not found' };

  const now = new Date().toISOString();
  let appliedCount = 1;

  if (applyToMerchant && txn.merchant) {
    await createPersonalRule({ userId: user.id, matchValue: txn.merchant, categoryName });
    const updated = await db
      .update(personalTransactions)
      .set({ category: categoryName, updatedAt: now })
      .where(and(eq(personalTransactions.userId, user.id), eq(personalTransactions.merchant, txn.merchant)))
      .returning({ id: personalTransactions.id });
    appliedCount = updated.length;
  } else {
    await db
      .update(personalTransactions)
      .set({ category: categoryName, updatedAt: now })
      .where(and(eq(personalTransactions.id, txnId), eq(personalTransactions.userId, user.id)));
  }

  revalidatePath('/personal/transactions');
  revalidatePath('/personal');
  revalidatePath('/personal/reports');
  return { ok: true, appliedCount };
}
