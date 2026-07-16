'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { scanAndStoreRecurring, setRecurringStatus } from '@/lib/personal/recurring';

export async function rescanRecurringAction(): Promise<{ ok?: boolean; found?: number; error?: string }> {
  const user = await requireSession();
  const found = await scanAndStoreRecurring(user.id, new Date());
  revalidatePath('/personal/recurring');
  revalidatePath('/personal/cashflow');
  return { ok: true, found };
}

export async function setRecurringStatusAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z
    .object({ id: z.string().min(1).max(64), status: z.enum(['active', 'hidden', 'cancelled']) })
    .safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await setRecurringStatus(user.id, parsed.data.id, parsed.data.status);
  revalidatePath('/personal/recurring');
  return { ok: true };
}
