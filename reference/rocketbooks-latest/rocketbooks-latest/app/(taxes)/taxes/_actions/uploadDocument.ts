'use server';

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { executeTaxIntakeTool } from '@/lib/tax/intake-tools';
import { uploadPdf, uploadedDocPath } from '@/lib/tax/storage';

export interface UploadDocState {
  error?: string;
  ok?: boolean;
  docType?: string;
  extracted?: number;
  flagged?: number;
  message?: string;
  /** Set when the upload was a prior-year return import. */
  priorReturn?: boolean;
  seededForms?: string[];
}

const MAX_PDF_BYTES = 25 * 1024 * 1024; // matches the tax-forms bucket file-size cap

/**
 * Upload a tax document (W-2 / 1099 / K-1 PDF) on the workspace, store it, then run
 * extract_tax_document — the same tool the AI assistant uses. Extracted values land as
 * UNCONFIRMED facts (with per-field confidence) for the preparer to review. Revalidates
 * so the freshly-extracted facts render.
 */
export async function uploadDocumentAction(
  _prev: UploadDocState | undefined,
  formData: FormData,
): Promise<UploadDocState> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const returnId = String(formData.get('return_id') ?? '');
  if (!returnId) return { error: 'Missing return id.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PDF to upload.' };
  if (file.type !== 'application/pdf') return { error: 'Upload a PDF (W-2, 1099, or K-1).' };
  if (file.size > MAX_PDF_BYTES) return { error: 'File is too large (max 25 MB).' };

  // 'PRIOR_RETURN' routes to the prior-return importer; any other value is a doc type
  // for the box-grid extractor (empty = auto-detect).
  const declaredType = (formData.get('doc_type') as string | null)?.trim() || undefined;
  const isPriorReturn = declaredType === 'PRIOR_RETURN';

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  const path = uploadedDocPath(returnId, sha);

  try {
    await uploadPdf(path, bytes);
  } catch (e) {
    return { error: `Upload failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (isPriorReturn) {
    const r = (await executeTaxIntakeTool({ organizationId: orgId }, 'import_prior_return', {
      return_id: returnId,
      storage_path: path,
    })) as { ok?: boolean; error?: string; returnType?: string; carriedForwardFacts?: number; seededForms?: string[]; unsupportedForms?: string[]; note?: string };
    if (!r?.ok) return { error: r?.error ?? 'Could not read the prior return.' };
    revalidatePath(`/taxes/${returnId}`);
    return {
      ok: true,
      priorReturn: true,
      docType: r.returnType,
      extracted: r.carriedForwardFacts ?? 0,
      seededForms: r.seededForms ?? [],
      message: r.note,
    };
  }

  const result = (await executeTaxIntakeTool({ organizationId: orgId }, 'extract_tax_document', {
    return_id: returnId,
    storage_path: path,
    ...(declaredType ? { doc_type: declaredType } : {}),
  })) as { ok?: boolean; error?: string; docType?: string; extracted?: number; flaggedForReview?: number; message?: string; note?: string };

  if (!result?.ok) return { error: result?.error ?? 'Could not read the document.' };
  if (result.docType === 'unknown') {
    return { ok: true, docType: 'unknown', extracted: 0, message: result.message ?? 'Could not identify the document type — enter the values manually.' };
  }

  revalidatePath(`/taxes/${returnId}`);
  return {
    ok: true,
    docType: result.docType,
    extracted: result.extracted ?? 0,
    flagged: result.flaggedForReview ?? 0,
    message: result.note,
  };
}
