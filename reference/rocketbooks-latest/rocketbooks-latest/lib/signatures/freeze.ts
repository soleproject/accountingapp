import 'server-only';
import type { SavedDocument } from '@/lib/documents/store';
import { downloadOrganizerDocument } from '@/lib/storage/organizer-documents';
import { uploadSignatureObject } from '@/lib/storage/signatures';
import { renderTextPdf } from './render-pdf';

export class FreezeError extends Error {}

function sourcePath(orgId: string, requestId: string): string {
  return `${orgId}/${requestId}/source.pdf`;
}

/**
 * Freeze a Documents-library item into the immutable signing PDF:
 *   - created drafts/decks  -> rendered to a flat text PDF (renderTextPdf)
 *   - uploaded PDFs         -> copied as-is
 *   - other uploads (docx…) -> rejected in v1 (no server-side conversion yet)
 * Returns the storage path of source.pdf.
 */
export async function freezeDocumentSource(orgId: string, requestId: string, doc: SavedDocument): Promise<string> {
  const path = sourcePath(orgId, requestId);

  if (doc.source === 'uploaded') {
    if (doc.mimeType !== 'application/pdf' || !doc.storagePath) {
      throw new FreezeError('Only PDF uploads can be sent for signature. Convert the file to PDF first.');
    }
    const bytes = await downloadOrganizerDocument(doc.storagePath);
    await uploadSignatureObject({ path, contentType: 'application/pdf', bytes });
    return path;
  }

  // Created document — render its content to a PDF.
  const bytes = await renderTextPdf(doc.title, doc.body);
  await uploadSignatureObject({ path, contentType: 'application/pdf', bytes });
  return path;
}

/** Freeze a freshly-uploaded PDF (must already be a PDF) into the signing PDF. */
export async function freezeFreshPdf(orgId: string, requestId: string, bytes: Uint8Array): Promise<string> {
  const path = sourcePath(orgId, requestId);
  await uploadSignatureObject({ path, contentType: 'application/pdf', bytes });
  return path;
}
