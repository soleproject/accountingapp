'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { eq, and } from 'drizzle-orm';
import { enqueueOutbound, fireOutboundDrain } from '@/lib/qbo/mirror/outbound';
import { serializeChartOfAccountToQbo } from '@/lib/qbo/mirror/serializers';
import { setAccountOpeningBalance } from '@/lib/accounting/opening-balance';

const Schema = z.object({
  accountNumber: z.string().min(1).max(20),
  accountName: z.string().min(1).max(200),
  gaapType: z.enum([
    'asset', 'current_asset', 'fixed_asset', 'other_asset',
    'liability', 'current_liability', 'long_term_liability', 'other_liability',
    'equity',
    'revenue', 'income', 'other_income',
    'expense', 'cost_of_goods_sold', 'other_expense',
  ]),
  accountType: z.string().max(100).optional(),
  parentAccountId: z.string().optional().nullable(),
  normalBalance: z.enum(['debit', 'credit']),
  startingBalance: z.coerce.number().default(0),
  startingBalanceDate: z.string().optional(),
});

export interface CreateAccountState { error?: string; }

export async function createAccount(_prev: CreateAccountState | undefined, formData: FormData): Promise<CreateAccountState | undefined> {
  const orgId = await getCurrentOrgId();
  const parsed = Schema.safeParse({
    accountNumber: formData.get('accountNumber'),
    accountName: formData.get('accountName'),
    gaapType: formData.get('gaapType'),
    accountType: formData.get('accountType') || undefined,
    parentAccountId: formData.get('parentAccountId') || null,
    normalBalance: formData.get('normalBalance'),
    startingBalance: formData.get('startingBalance') || 0,
    startingBalanceDate: formData.get('startingBalanceDate') || undefined,
  });
  if (!parsed.success) return { error: 'Invalid input. All fields with * are required.' };

  if (parsed.data.parentAccountId) {
    const [parent] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, parsed.data.parentAccountId), eq(chartOfAccounts.organizationId, orgId)))
      .limit(1);
    if (!parent) return { error: 'Parent account not in this organization' };
  }

  const accountId = randomUUID();
  const row: typeof chartOfAccounts.$inferInsert = {
    id: accountId,
    organizationId: orgId,
    accountNumber: parsed.data.accountNumber,
    accountName: parsed.data.accountName,
    gaapType: parsed.data.gaapType,
    accountType: parsed.data.accountType ?? null,
    parentAccountId: parsed.data.parentAccountId ?? null,
    normalBalance: parsed.data.normalBalance,
    isActive: true,
    isTemporary: false,
    createdByAi: false,
    systemGenerated: false,
    needsReview: false,
    startingBalance: parsed.data.startingBalance ? String(parsed.data.startingBalance) : null,
    passedNameContactCheck: true,
  };

  // Insert + outbound enqueue ride one transaction. Serializer reads the
  // row we're about to insert; passing the row object directly (instead
  // of re-reading) avoids a redundant SELECT and keeps the payload aligned
  // with what just got committed.
  const queueIds = await db.transaction(async (tx) => {
    await tx.insert(chartOfAccounts).values(row);
    const enqueued: string[] = [];
    // Cast our $inferInsert row to the $inferSelect shape expected by the
    // serializer. The fields the serializer reads (accountName, gaapType,
    // accountType, accountNumber, isActive) are all present on the insert
    // row; the rest don't matter to the QBO body.
    const fullRow = {
      ...row,
      parentAccountId: row.parentAccountId ?? null,
      complianceNote: null,
      startingBalanceDate: null,
      definition: null,
      suggestedMatchCoaId: null,
      detailType: null,
    } as typeof chartOfAccounts.$inferSelect;
    const qid = await enqueueOutbound(tx, {
      organizationId: orgId,
      entityType: 'account',
      localId: accountId,
      operation: 'create',
      payload: serializeChartOfAccountToQbo(fullRow) as unknown as Record<string, unknown>,
    });
    if (qid) enqueued.push(qid);
    return enqueued;
  });

  await fireOutboundDrain(queueIds);

  // Post the opening-balance JE (Debit/Credit vs Opening Balance Equity) so the
  // starting balance actually lands in the ledger instead of just sitting on
  // the row. Defaults to today if no date was given.
  if (parsed.data.startingBalance && parsed.data.startingBalance !== 0) {
    const rawDate = (parsed.data.startingBalanceDate ?? '').slice(0, 10);
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
    try {
      await setAccountOpeningBalance({
        organizationId: orgId,
        accountId,
        amount: parsed.data.startingBalance,
        asOfDate,
        source: 'manual',
      });
    } catch {
      // Account is created; opening JE failure shouldn't block the redirect.
    }
  }

  revalidatePath('/chart-of-accounts');
  redirect('/chart-of-accounts');
}
