'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { organizerDocuments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import {
  uploadOrganizerDocument,
  ORGANIZER_DOC_ALLOWED_MIME,
  ORGANIZER_DOC_MAX_BYTES,
} from '@/lib/storage/organizer-documents';
import { logger } from '@/lib/logger';

export interface UploadDocumentState {
  error?: string;
}

/**
 * Upload an existing file into the Documents list (the "Uploaded" tab).
 * The file goes to the private organizer-documents bucket; a sibling
 * organizer_documents row (source = 'uploaded') records the metadata so
 * it lists alongside created drafts. Org + user scoped.
 */
export async function uploadDocumentAction(
  _prev: UploadDocumentState | undefined,
  formData: FormData,
): Promise<UploadDocumentState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a file to upload.' };
  }
  if (file.size > ORGANIZER_DOC_MAX_BYTES) {
    return { error: `File is too large (max ${Math.round(ORGANIZER_DOC_MAX_BYTES / (1024 * 1024))} MB).` };
  }
  if (file.type && !ORGANIZER_DOC_ALLOWED_MIME.includes(file.type)) {
    return { error: 'Unsupported file type. Upload a PDF, Office doc, text, or image file.' };
  }

  const id = randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = file.type || 'application/octet-stream';

  try {
    const { path } = await uploadOrganizerDocument({
      organizationId: orgId,
      documentId: id,
      filename: file.name,
      contentType,
      bytes,
    });

    await db.insert(organizerDocuments).values({
      id,
      organizationId: orgId,
      userId,
      kind: 'upload',
      title: file.name,
      body: '',
      source: 'uploaded',
      storagePath: path,
      mimeType: contentType,
      fileSize: file.size,
      originalFilename: file.name,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'organizer document upload failed');
    return { error: 'Upload failed. Please try again.' };
  }

  revalidatePath('/organizer/documents');
  return undefined;
}
