'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { organizerDocuments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface SaveDocumentResult {
  id?: string;
  error?: string;
}

const Schema = z.object({
  id: z.string().min(1).max(64).nullable().optional(),
  kind: z.enum(['letter', 'email', 'text', 'resolution', 'deck']),
  title: z.string().max(300),
  body: z.string().min(1).max(100_000),
});

/**
 * Save (insert or update) a standalone document from the Create workspace.
 * Returns the document id so the client can keep updating the same row as the
 * user iterates. Org + user scoped. On update, the row must belong to the org.
 */
export async function saveDocumentAction(input: unknown): Promise<SaveDocumentResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid document.' };
  const { id, kind, title, body } = parsed.data;
  const now = new Date().toISOString();

  if (id) {
    // Update only if it exists in this org (cross-tenant guard).
    const [existing] = await db
      .select({ id: organizerDocuments.id })
      .from(organizerDocuments)
      .where(and(eq(organizerDocuments.id, id), eq(organizerDocuments.organizationId, orgId)))
      .limit(1);
    if (existing) {
      await db
        .update(organizerDocuments)
        .set({ kind, title, body, updatedAt: now })
        .where(eq(organizerDocuments.id, id));
      return { id };
    }
    // Fall through to insert if the id no longer resolves (stale client id).
  }

  const newId = randomUUID();
  await db.insert(organizerDocuments).values({
    id: newId,
    organizationId: orgId,
    userId,
    kind,
    title,
    body,
    updatedAt: now,
  });
  return { id: newId };
}
