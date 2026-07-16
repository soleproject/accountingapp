import 'server-only';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { signatureRequests } from '@/db/schema/schema';
import type { SavedDocument } from '@/lib/documents/store';
import { freezeDocumentSource, freezeFreshPdf } from './freeze';
import { recordEvent } from './store';

/** Create a draft request from a Documents item (freezes the source PDF). */
export async function createRequestFromDocument(orgId: string, userId: string | null, doc: SavedDocument): Promise<string> {
  const id = randomUUID();
  const sourcePdfPath = await freezeDocumentSource(orgId, id, doc);
  await db.insert(signatureRequests).values({
    id,
    organizationId: orgId,
    userId,
    title: doc.title || doc.originalFilename || 'Untitled document',
    status: 'draft',
    sourceDocumentId: doc.id,
    sourcePdfPath,
  });
  await recordEvent({ requestId: id, type: 'created', meta: { sourceDocumentId: doc.id } });
  return id;
}

/** Create a draft request from a freshly-uploaded PDF. */
export async function createRequestFromPdf(orgId: string, userId: string | null, title: string, bytes: Uint8Array): Promise<string> {
  const id = randomUUID();
  const sourcePdfPath = await freezeFreshPdf(orgId, id, bytes);
  await db.insert(signatureRequests).values({
    id,
    organizationId: orgId,
    userId,
    title,
    status: 'draft',
    sourcePdfPath,
  });
  await recordEvent({ requestId: id, type: 'created', meta: { fresh: true } });
  return id;
}
