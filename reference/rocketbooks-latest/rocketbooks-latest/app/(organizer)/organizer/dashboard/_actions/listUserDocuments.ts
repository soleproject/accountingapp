'use server';

import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { listDocuments, type DocumentListItem } from '@/lib/documents/store';

export interface UserDocumentsResult {
  ok: boolean;
  documents: DocumentListItem[];
  error?: string;
}

/**
 * All of the current user's standalone documents (created drafts + uploaded
 * files), most-recently-updated first — for the "attach document" dropdown on
 * compose steps. Reuses the same store the Documents page reads, so a doc
 * drafted in a step (mirrored into organizer_documents) shows up here too.
 */
export async function listUserDocuments(): Promise<UserDocumentsResult> {
  try {
    await requireSession();
    const orgId = await getCurrentOrgId();
    const userId = await getEffectiveUserId();
    const documents = await listDocuments(orgId, userId);
    return { ok: true, documents };
  } catch (err) {
    return { ok: false, documents: [], error: err instanceof Error ? err.message : 'Failed to load documents' };
  }
}
