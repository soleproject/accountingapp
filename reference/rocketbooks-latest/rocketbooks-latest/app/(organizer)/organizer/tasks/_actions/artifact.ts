'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { tasks, taskArtifacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface SaveArtifactResult {
  ok?: boolean;
  error?: string;
}

const Schema = z.object({
  taskId: z.string().min(1).max(64),
  kind: z.enum(['letter', 'email', 'text', 'resolution', 'deck']),
  title: z.string().max(300),
  body: z.string().min(1).max(100_000),
});

/**
 * Upsert the current draft for a task's workspace canvas. One row per task
 * (UNIQUE on task_id), so this is the autosave target — repeated calls just
 * overwrite the latest content. Org-scoped: the task must belong to the
 * caller's org (cross-tenant writes impossible even with a forged taskId).
 */
export async function saveTaskArtifactAction(input: unknown): Promise<SaveArtifactResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid artifact.' };
  const { taskId, kind, title, body } = parsed.data;

  // Org-scope the task (not user-scope — the workspace itself is org-scoped,
  // matching getTaskContextPack, so demo/shared orgs keep working).
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)))
    .limit(1);
  if (!task) return { error: 'Task not found.' };

  const now = new Date().toISOString();
  await db
    .insert(taskArtifacts)
    .values({ id: randomUUID(), organizationId: orgId, taskId, userId, kind, title, body, updatedAt: now })
    .onConflictDoUpdate({
      target: taskArtifacts.taskId,
      set: { kind, title, body, userId, updatedAt: now },
    });

  return { ok: true };
}
