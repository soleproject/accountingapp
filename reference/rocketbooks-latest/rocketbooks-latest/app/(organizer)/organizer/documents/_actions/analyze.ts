'use server';

import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getDocument, documentContentHash, saveDocumentBreakdown } from '@/lib/documents/store';
import { analyzeDocument, type DocumentBreakdown } from '@/lib/documents/analyze';

export interface AnalyzeResult {
  ok: boolean;
  breakdown?: DocumentBreakdown;
  error?: string;
}

/**
 * (Re)generate the AI breakdown for the view page and persist it, tagged with
 * the content hash it was generated against so the view can detect staleness.
 * Called when no breakdown exists yet or when the user asks to rerun after the
 * document changed. Org-scoped via getDocument.
 */
export async function analyzeDocumentAction(id: string): Promise<AnalyzeResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const doc = await getDocument(orgId, id);
  if (!doc) return { ok: false, error: 'Document not found' };

  const breakdown = await analyzeDocument({
    orgId,
    userId,
    kind: doc.kind,
    title: doc.title,
    body: doc.body,
    source: doc.source,
    filename: doc.originalFilename,
    mimeType: doc.mimeType,
  });
  if (!breakdown) return { ok: false, error: 'Could not analyze this document right now.' };

  await saveDocumentBreakdown(orgId, id, breakdown, documentContentHash(doc));
  return { ok: true, breakdown };
}
