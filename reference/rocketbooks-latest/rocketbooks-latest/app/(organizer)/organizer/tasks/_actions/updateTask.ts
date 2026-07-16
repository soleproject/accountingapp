'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface UpdateTaskState {
  error?: string;
  ok?: boolean;
}

const Schema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().nullable(),
  dueDate: z.string().trim().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', '']).optional(),
});

/**
 * Direct (non-AI) task edit used by the inline pencil editor on the
 * Tasks page. Same scoping discipline as deleteTaskAction — id is
 * validated against the current user + org so cross-tenant edits are
 * impossible even with a forged form value.
 */
export async function updateTaskAction(
  _prev: UpdateTaskState | undefined,
  formData: FormData,
): Promise<UpdateTaskState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const rawDesc = formData.get('description');
  const rawDue = formData.get('dueDate');
  const rawPri = formData.get('priority');

  const parsed = Schema.safeParse({
    id: formData.get('id'),
    title: formData.get('title'),
    description: typeof rawDesc === 'string' ? rawDesc : null,
    dueDate: typeof rawDue === 'string' ? rawDue : null,
    priority: typeof rawPri === 'string' ? rawPri : '',
  });
  if (!parsed.success) return { error: 'Title is required (max 200 chars).' };

  // Confirm ownership first so a bad id surfaces as "not found" rather
  // than silently succeeding with zero rows updated.
  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, userId), eq(tasks.organizationId, orgId)))
    .limit(1);
  if (!existing) return { error: 'Task not found.' };

  // dueDate input is type=date → YYYY-MM-DD. Store as midnight UTC so
  // it sorts cleanly next to other timestamps. Empty string clears.
  let dueDate: string | null = null;
  const due = parsed.data.dueDate?.trim() ?? '';
  if (due.length > 0) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      dueDate = `${due}T00:00:00Z`;
    } else {
      const d = new Date(due);
      if (Number.isNaN(d.getTime())) return { error: 'Invalid due date.' };
      dueDate = d.toISOString();
    }
  }

  const description = parsed.data.description?.trim();
  const priority = parsed.data.priority && parsed.data.priority.length > 0 ? parsed.data.priority : null;

  await db
    .update(tasks)
    .set({
      title: parsed.data.title,
      description: description && description.length > 0 ? description : null,
      dueDate,
      priority,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, parsed.data.id));

  revalidatePath('/organizer/tasks');
  revalidatePath('/organizer/dashboard');
  return { ok: true };
}
