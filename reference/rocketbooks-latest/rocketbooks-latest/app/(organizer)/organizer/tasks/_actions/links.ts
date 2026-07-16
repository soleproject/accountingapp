'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, taskLinks } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg, assertNotDemo } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import {
  getTaskLinks,
  listLinkableEntities,
  entityExistsInOrg,
} from '@/lib/task-links/queries';
import {
  isTaskLinkEntityType,
  type LinkableEntityOption,
  type ResolvedTaskLink,
  type TaskLinkEntityType,
} from '@/lib/task-links/types';

export interface LinkActionResult {
  ok?: boolean;
  error?: string;
}

/** Read the current resolved links for a task. Org-scoped (shared in demo). */
export async function getTaskLinksAction(taskId: string): Promise<ResolvedTaskLink[]> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (typeof taskId !== 'string' || !taskId) return [];
  return getTaskLinks(orgId, taskId);
}

/** Options for the "add link" picker for a given entity type. */
export async function listLinkableEntitiesAction(
  type: string,
  query?: string,
): Promise<LinkableEntityOption[]> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  if (!isTaskLinkEntityType(type)) return [];
  // Shared demo org drops the per-viewer user filter (mirrors the dashboard).
  const userScope = isDemoOrg(orgId) ? null : userId;
  return listLinkableEntities(orgId, type, userScope, query);
}

/** Confirm the task belongs to the current user + org (cross-tenant guard). */
async function assertOwnsTask(taskId: string, userId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), eq(tasks.organizationId, orgId)))
    .limit(1);
  return !!row;
}

async function readContactIds(taskId: string): Promise<string[]> {
  const [row] = await db.select({ assigned: tasks.assignedToContacts }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const raw = row?.assigned;
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

export async function addTaskLinkAction(
  taskId: string,
  type: string,
  entityId: string,
): Promise<LinkActionResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'link tasks');

  if (!isTaskLinkEntityType(type)) return { error: 'Unknown link type.' };
  if (typeof taskId !== 'string' || !taskId || typeof entityId !== 'string' || !entityId) {
    return { error: 'Missing task or entity.' };
  }
  if (!(await assertOwnsTask(taskId, userId, orgId))) return { error: 'Task not found.' };
  if (!(await entityExistsInOrg(orgId, type as TaskLinkEntityType, entityId))) {
    return { error: 'That item no longer exists.' };
  }

  if (type === 'contact') {
    const ids = await readContactIds(taskId);
    if (!ids.includes(entityId)) {
      await db
        .update(tasks)
        .set({ assignedToContacts: [...ids, entityId], updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId));
    }
  } else {
    await db
      .insert(taskLinks)
      .values({ id: randomUUID(), organizationId: orgId, taskId, entityType: type, entityId })
      .onConflictDoNothing();
  }

  revalidatePath('/organizer/tasks');
  revalidatePath('/organizer/dashboard');
  return { ok: true };
}

export async function removeTaskLinkAction(
  taskId: string,
  type: string,
  entityId: string,
): Promise<LinkActionResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  assertNotDemo(orgId, 'link tasks');

  if (!isTaskLinkEntityType(type)) return { error: 'Unknown link type.' };
  if (!(await assertOwnsTask(taskId, userId, orgId))) return { error: 'Task not found.' };

  if (type === 'contact') {
    const ids = await readContactIds(taskId);
    if (ids.includes(entityId)) {
      await db
        .update(tasks)
        .set({ assignedToContacts: ids.filter((c) => c !== entityId), updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId));
    }
  } else {
    await db
      .delete(taskLinks)
      .where(
        and(
          eq(taskLinks.organizationId, orgId),
          eq(taskLinks.taskId, taskId),
          eq(taskLinks.entityType, type),
          eq(taskLinks.entityId, entityId),
        ),
      );
  }

  revalidatePath('/organizer/tasks');
  revalidatePath('/organizer/dashboard');
  return { ok: true };
}
