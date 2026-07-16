'use server';

import { redirect } from 'next/navigation';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getDocument } from '@/lib/documents/store';
import { FreezeError } from '@/lib/signatures/freeze';
import { createRequestFromDocument, createRequestFromPdf } from '@/lib/signatures/create';
import { logger } from '@/lib/logger';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface CreateRequestState {
  error?: string;
}

/**
 * Start a signature request from either an existing Documents item
 * (documentId) or a freshly-uploaded PDF (file). Freezes the source into the
 * immutable signing PDF, then redirects into the field-placement builder.
 */
export async function createRequestAction(
  _prev: CreateRequestState | undefined,
  formData: FormData,
): Promise<CreateRequestState | undefined> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const documentId = (formData.get('documentId') as string | null)?.trim() || null;
  const file = formData.get('file');
  let id: string;

  try {
    if (documentId) {
      const doc = await getDocument(orgId, documentId);
      if (!doc) return { error: 'Document not found.' };
      id = await createRequestFromDocument(orgId, userId, doc);
    } else if (file instanceof File && file.size > 0) {
      if (file.type !== 'application/pdf') return { error: 'Upload a PDF to send for signature.' };
      if (file.size > MAX_PDF_BYTES) return { error: 'File is too large (max 25 MB).' };
      id = await createRequestFromPdf(orgId, userId, file.name.replace(/\.pdf$/i, ''), new Uint8Array(await file.arrayBuffer()));
    } else {
      return { error: 'Choose a document or upload a PDF.' };
    }
  } catch (err) {
    if (err instanceof FreezeError) return { error: err.message };
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'signature freeze failed');
    return { error: 'Could not prepare the document. Please try again.' };
  }

  redirect(`/organizer/signatures/${id}`);
}
