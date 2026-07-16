import 'server-only';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { documentRecords } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

interface PdfJobRow {
  id: string;
  documentRecordId: string;
  organizationId: string | null;
  status: string;
  pdfUrl: string | null;
  errorMessage: string | null;
}

async function updatePdfJob(jobId: string, fields: Record<string, string | null>): Promise<void> {
  const assignments = Object.entries(fields)
    .map(([key, value]) => `${key} = ${value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`}`)
    .join(', ');
  await db.execute(sql.raw(`UPDATE pdf_jobs SET ${assignments}, updated_at = now() WHERE id = '${jobId.replaceAll("'", "''")}'`));
}

/**
 * Render document_records.draft into a PDF outside the hot request path.
 * Heavy pdf-lib/signature storage modules are imported inside step.run() so
 * they stay out of the thin /api/pdf/generate route bundle.
 */
export const pdfGeneratorFunction = inngest.createFunction(
  {
    id: 'pdf-generator',
    concurrency: { limit: 2, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'pdf/generate.requested' }],
  },
  async ({ event, step }) => {
    const { jobId, documentRecordId, organizationId } = event.data as {
      jobId: string;
      documentRecordId: string;
      organizationId: string;
    };

    await step.run('mark-running', () => updatePdfJob(jobId, { status: 'running', error_message: null }));

    try {
      const result = await step.run('render-and-upload-pdf', async (): Promise<PdfJobRow> => {
        const [doc] = await db
          .select({
            id: documentRecords.id,
            organizationId: documentRecords.organizationId,
            templateId: documentRecords.templateId,
            draft: documentRecords.draft,
          })
          .from(documentRecords)
          .where(eq(documentRecords.id, documentRecordId))
          .limit(1);

        if (!doc) throw new Error('document record not found');
        if (doc.organizationId && doc.organizationId !== organizationId) {
          throw new Error('document does not belong to current organization');
        }

        const [{ renderTextPdf }, { uploadSignatureObject }] = await Promise.all([
          import('@/lib/signatures/render-pdf'),
          import('@/lib/storage/signatures'),
        ]);
        const bytes = await renderTextPdf(doc.templateId || 'Document', doc.draft || '');
        const path = `${organizationId}/generated/${documentRecordId}-${randomUUID()}.pdf`;
        await uploadSignatureObject({ path, contentType: 'application/pdf', bytes });

        await db.update(documentRecords).set({ pdfUrl: path, updatedAt: new Date().toISOString() }).where(eq(documentRecords.id, documentRecordId));
        await updatePdfJob(jobId, { status: 'completed', pdf_url: path, error_message: null });

        return { id: jobId, documentRecordId, organizationId, status: 'completed', pdfUrl: path, errorMessage: null };
      });

      return JSON.parse(JSON.stringify(result)) as PdfJobRow;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run('mark-failed', () => updatePdfJob(jobId, { status: 'failed', error_message: message.slice(0, 1000) }));
      logger.error({ jobId, documentRecordId, err: message }, 'pdf generation failed');
      throw err;
    }
  },
);
