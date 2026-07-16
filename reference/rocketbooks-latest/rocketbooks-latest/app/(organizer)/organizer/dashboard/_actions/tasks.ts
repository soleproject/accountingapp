'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface DeleteTaskState {
  error?: string;
  ok?: boolean;
}

/**
 * Direct (non-AI) task delete used by the trash button on the
 * dashboard's Open Tasks card. Server action — scoped to the current
 * user + org so a bad form-submitted id can't reach across tenants.
 */
export async function deleteTaskAction(
  _prev: DeleteTaskState | undefined,
  formData: FormData,
): Promise<DeleteTaskState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'id required' };

  const deleted = await db
    .delete(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId), eq(tasks.organizationId, orgId)))
    .returning({ id: tasks.id });

  if (deleted.length === 0) return { error: 'Task not found.' };

  revalidatePath('/organizer/dashboard');
  revalidatePath('/organizer/tasks');
  return { ok: true };
}
