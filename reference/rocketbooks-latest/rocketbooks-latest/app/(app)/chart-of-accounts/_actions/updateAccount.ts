'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { eq, and } from 'drizzle-orm';

const Schema = z.object({
  id: z.string().min(1),
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
  detailType: z.string().max(100).optional(),
  parentAccountId: z.string().optional().nullable(),
  normalBalance: z.enum(['debit', 'credit']),
  isActive: z.boolean(),
});

export interface UpdateAccountState { error?: string }

export async function updateAccount(_prev: UpdateAccountState | undefined, formData: FormData): Promise<UpdateAccountState | undefined> {
  const orgId = await getCurrentOrgId();
  const parsed = Schema.safeParse({
    id: formData.get('id'),
    accountNumber: formData.get('accountNumber'),
    accountName: formData.get('accountName'),
    gaapType: formData.get('gaapType'),
    accountType: formData.get('accountType') || undefined,
    detailType: formData.get('detailType') || undefined,
    parentAccountId: formData.get('parentAccountId') || null,
    normalBalance: formData.get('normalBalance'),
    // Native checkbox sends 'on' when checked, nothing when not. Coerce
    // explicitly so a missing field reads as false (un-checked) rather
    // than failing the schema.
    isActive: formData.get('isActive') === 'on',
  });
  if (!parsed.success) return { error: 'Invalid input. All fields with * are required.' };

  // Verify the account belongs to this org. Stops a user from editing
  // another org's row by guessing the id.
  const [existing] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, parsed.data.id), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!existing) return { error: 'Account not found' };

  if (parsed.data.parentAccountId) {
    if (parsed.data.parentAccountId === parsed.data.id) {
      return { error: 'An account cannot be its own parent' };
    }
    const [parent] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, parsed.data.parentAccountId), eq(chartOfAccounts.organizationId, orgId)))
      .limit(1);
    if (!parent) return { error: 'Parent account not in this organization' };
  }

  await db
    .update(chartOfAccounts)
    .set({
      accountNumber: parsed.data.accountNumber,
      accountName: parsed.data.accountName,
      gaapType: parsed.data.gaapType,
      accountType: parsed.data.accountType ?? null,
      detailType: parsed.data.detailType ?? null,
      parentAccountId: parsed.data.parentAccountId ?? null,
      normalBalance: parsed.data.normalBalance,
      isActive: parsed.data.isActive,
    })
    .where(eq(chartOfAccounts.id, parsed.data.id));

  revalidatePath('/chart-of-accounts');
  redirect('/chart-of-accounts');
}
