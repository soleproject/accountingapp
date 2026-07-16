'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizerDocuments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getOrganizerDocumentSignedUrl } from '@/lib/storage/organizer-documents';

export interface DownloadDocumentResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Resolve a time-limited download URL for an uploaded document. Scoped
 * to the org so a leaked id can't cross tenants.
 */
export async function getDocumentDownloadUrl(id: string): Promise<DownloadDocumentResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [row] = await db
    .select({ storagePath: organizerDocuments.storagePath, source: organizerDocuments.source })
    .from(organizerDocuments)
    .where(and(eq(organizerDocuments.id, id), eq(organizerDocuments.organizationId, orgId)))
    .limit(1);

  if (!row || row.source !== 'uploaded' || !row.storagePath) {
    return { ok: false, error: 'Document not found' };
  }

  try {
    const url = await getOrganizerDocumentSignedUrl(row.storagePath);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to sign URL' };
  }
}
