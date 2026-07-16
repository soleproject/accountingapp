'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { organizerDocuments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { deleteOrganizerDocument } from '@/lib/storage/organizer-documents';

export interface DeleteDocumentResult {
  ok: boolean;
  error?: string;
}

/**
 * Delete a document (created draft or uploaded file). Org-scoped so a
 * leaked id can't reach another tenant's row. For uploads, the storage
 * object is removed best-effort before the row (an orphaned object is
 * harmless; an orphaned row would dangle a dead download link).
 */
export async function deleteDocumentAction(id: string): Promise<DeleteDocumentResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [row] = await db
    .select({ source: organizerDocuments.source, storagePath: organizerDocuments.storagePath })
    .from(organizerDocuments)
    .where(and(eq(organizerDocuments.id, id), eq(organizerDocuments.organizationId, orgId)))
    .limit(1);
  if (!row) return { ok: false, error: 'Document not found' };

  if (row.source === 'uploaded' && row.storagePath) {
    await deleteOrganizerDocument(row.storagePath);
  }

  await db
    .delete(organizerDocuments)
    .where(and(eq(organizerDocuments.id, id), eq(organizerDocuments.organizationId, orgId)));

  revalidatePath('/organizer/documents');
  return { ok: true };
}
