'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { createBudget, updateBudget, deleteBudget } from '@/lib/personal/budgets';

function revalidate() {
  revalidatePath('/personal/budget');
  revalidatePath('/personal');
}

export async function createBudgetAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z
    .object({
      category: z.string().min(1).max(120),
      monthlyLimit: z.number().nonnegative().finite(),
      rollover: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await createBudget({ userId: user.id, ...parsed.data });
  revalidate();
  return { ok: true };
}

export async function updateBudgetAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z
    .object({
      id: z.string().min(1).max(64),
      monthlyLimit: z.number().nonnegative().finite().optional(),
      rollover: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await updateBudget({ userId: user.id, ...parsed.data });
  revalidate();
  return { ok: true };
}

export async function deleteBudgetAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await deleteBudget(user.id, parsed.data.id);
  revalidate();
  return { ok: true };
}
