'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConflicts, qboEntityMap } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface DismissConflictState { error?: string }

/**
 * Dismiss a conflict. Marks the row resolved, flips the related
 * entity_map back to 'synced' so outbound pushes resume, and records the
 * resolving user.
 *
 * Dismissal explicitly does NOT touch local OR QBO state — the user is
 * saying "I've reconciled this manually outside the app." A future
 * "Use Ours" / "Use QBO" pair will add side-applying actions.
 */
export async function dismissConflict(conflictId: string): Promise<DismissConflictState | undefined> {
  const orgId = await getCurrentOrgId();
  const session = await requireSession();
  const userId = session.id;
  const now = new Date().toISOString();

  const [conflict] = await db
    .select({ id: qboConflicts.id, entityMapId: qboConflicts.entityMapId, resolvedAt: qboConflicts.resolvedAt })
    .from(qboConflicts)
    .where(and(eq(qboConflicts.id, conflictId), eq(qboConflicts.organizationId, orgId)))
    .limit(1);
  if (!conflict) return { error: 'Conflict not found' };
  if (conflict.resolvedAt) return { error: 'Already resolved' };

  await db.transaction(async (tx) => {
    await tx
      .update(qboConflicts)
      .set({ resolution: 'dismissed', resolvedAt: now, resolvedByUserId: userId, updatedAt: now })
      .where(eq(qboConflicts.id, conflictId));
    // Only flip back to synced if this was the last open conflict for the
    // entity. A single entity can theoretically accumulate multiple
    // conflicts if more inbound events arrive before resolution.
    const stillOpen = await tx
      .select({ id: qboConflicts.id })
      .from(qboConflicts)
      .where(and(eq(qboConflicts.entityMapId, conflict.entityMapId), isNull(qboConflicts.resolvedAt)))
      .limit(1);
    if (stillOpen.length === 0) {
      await tx
        .update(qboEntityMap)
        .set({ syncStatus: 'synced', lastError: null, updatedAt: now })
        .where(eq(qboEntityMap.id, conflict.entityMapId));
    }
  });

  revalidatePath('/integrations/qbo/conflicts');
  revalidatePath('/integrations/qbo');
  return undefined;
}
