'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import {
  createPersonalCategory,
  updatePersonalCategory,
  archivePersonalCategory,
  deletePersonalRule,
} from '@/lib/personal/categories';

function revalidate() {
  revalidatePath('/personal/categories');
  revalidatePath('/personal/transactions');
  revalidatePath('/personal/budget');
  revalidatePath('/personal/reports');
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  groupName: z.string().min(1).max(120),
  rollover: z.boolean().optional(),
});

export async function createCategoryAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await createPersonalCategory({ userId: user.id, ...parsed.data });
  revalidate();
  return { ok: true };
}

const UpdateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120).optional(),
  groupName: z.string().min(1).max(120).optional(),
  rollover: z.boolean().optional(),
});

export async function updateCategoryAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await updatePersonalCategory({ userId: user.id, ...parsed.data });
  revalidate();
  return { ok: true };
}

export async function archiveCategoryAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z.object({ id: z.string().min(1).max(64), archived: z.boolean() }).safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await archivePersonalCategory(user.id, parsed.data.id, parsed.data.archived);
  revalidate();
  return { ok: true };
}

export async function deleteRuleAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireSession();
  const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(input);
  if (!parsed.success) return { error: 'Invalid input' };
  await deletePersonalRule(user.id, parsed.data.id);
  revalidate();
  return { ok: true };
}
