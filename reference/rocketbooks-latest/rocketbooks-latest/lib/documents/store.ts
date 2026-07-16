import 'server-only';
import { createHash } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizerDocuments } from '@/db/schema/schema';
import type { DocumentBreakdown } from './analyze';

export interface SavedDocument {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  storagePath: string | null;
  mimeType: string | null;
  originalFilename: string | null;
  fileSize: number | null;
  updatedAt: string;
  /** Cached AI breakdown + the content hash it was generated against. */
  aiBreakdown: DocumentBreakdown | null;
  aiBreakdownHash: string | null;
}

/**
 * Stable hash of the content an AI breakdown is derived from. Created docs hash
 * their kind/title/body (the analyzed text); uploads hash their file identity
 * (which doesn't change). When this differs from the stored ai_breakdown_hash,
 * the saved breakdown is stale.
 */
export function documentContentHash(doc: {
  kind: string;
  title: string;
  body: string;
  source: string;
  storagePath: string | null;
  mimeType: string | null;
  originalFilename: string | null;
}): string {
  const basis =
    doc.source === 'uploaded'
      ? `uploaded\n${doc.storagePath ?? ''}\n${doc.mimeType ?? ''}\n${doc.originalFilename ?? ''}`
      : `created\n${doc.kind}\n${doc.title}\n${doc.body}`;
  return createHash('sha256').update(basis).digest('hex');
}

/** Persist a generated breakdown + the hash it was generated against. Does not
 *  touch updated_at — caching the summary is not a content edit. Org-scoped. */
export async function saveDocumentBreakdown(
  orgId: string,
  id: string,
  breakdown: DocumentBreakdown,
  hash: string,
): Promise<void> {
  await db
    .update(organizerDocuments)
    .set({ aiBreakdown: breakdown, aiBreakdownHash: hash, aiBreakdownAt: new Date().toISOString() })
    .where(and(eq(organizerDocuments.id, id), eq(organizerDocuments.organizationId, orgId)));
}

export interface DocumentListItem {
  id: string;
  kind: string;
  title: string;
  updatedAt: string;
  /** 'created' (drafted in the Create workspace) | 'uploaded' (a user file). */
  source: string;
  mimeType: string | null;
  originalFilename: string | null;
}

/** Load one standalone document (org-scoped), or null. */
export async function getDocument(orgId: string, id: string): Promise<SavedDocument | null> {
  if (!id) return null;
  const [row] = await db
    .select({
      id: organizerDocuments.id,
      kind: organizerDocuments.kind,
      title: organizerDocuments.title,
      body: organizerDocuments.body,
      source: organizerDocuments.source,
      storagePath: organizerDocuments.storagePath,
      mimeType: organizerDocuments.mimeType,
      originalFilename: organizerDocuments.originalFilename,
      fileSize: organizerDocuments.fileSize,
      updatedAt: organizerDocuments.updatedAt,
      aiBreakdown: organizerDocuments.aiBreakdown,
      aiBreakdownHash: organizerDocuments.aiBreakdownHash,
    })
    .from(organizerDocuments)
    .where(and(eq(organizerDocuments.organizationId, orgId), eq(organizerDocuments.id, id)))
    .limit(1);
  if (!row) return null;
  // jsonb columns infer as `unknown`; the breakdown is written only by
  // saveDocumentBreakdown, so it conforms to DocumentBreakdown.
  return { ...row, aiBreakdown: (row.aiBreakdown ?? null) as DocumentBreakdown | null };
}

/** List a user's saved documents, most-recently-updated first. */
export async function listDocuments(orgId: string, userId: string): Promise<DocumentListItem[]> {
  return db
    .select({
      id: organizerDocuments.id,
      kind: organizerDocuments.kind,
      title: organizerDocuments.title,
      updatedAt: organizerDocuments.updatedAt,
      source: organizerDocuments.source,
      mimeType: organizerDocuments.mimeType,
      originalFilename: organizerDocuments.originalFilename,
    })
    .from(organizerDocuments)
    .where(and(eq(organizerDocuments.organizationId, orgId), eq(organizerDocuments.userId, userId)))
    .orderBy(desc(organizerDocuments.updatedAt))
    .limit(100);
}
