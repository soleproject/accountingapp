import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgBranding } from '@/lib/documents/branding';
import { getDocument, documentContentHash } from '@/lib/documents/store';
import type { DocKind } from '@/lib/documents/layout';
import { getOrganizerDocumentSignedUrl } from '@/lib/storage/organizer-documents';
import { sendDocumentForSignatureAction } from '@/app/(organizer)/organizer/signatures/_actions/fromDocument';
import { DocumentViewer } from '../_components/DocumentViewer';
import { DocPreview } from '../_components/DocPreview';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Read-only view for a saved document: the rendered document/presentation on
 * the left, an AI breakdown of what it is and what it's for on the right.
 * Distinct from the edit surface (/organizer/create?doc=<id>) reached via the
 * pencil. Uploaded files preview via a short-lived signed URL.
 */
export default async function DocumentViewPage({ params }: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  const [doc, branding] = await Promise.all([getDocument(orgId, id), getOrgBranding(orgId)]);
  if (!doc) notFound();

  const isUploaded = doc.source === 'uploaded';
  const signedUrl = isUploaded && doc.storagePath ? await getOrganizerDocumentSignedUrl(doc.storagePath).catch(() => null) : null;

  // The saved breakdown is stale when the live content no longer matches the
  // hash it was generated against — the viewer then offers to rerun it.
  const breakdownStale = doc.aiBreakdown != null && doc.aiBreakdownHash !== documentContentHash(doc);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/organizer/documents"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200/80 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 dark:border-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
            aria-label="Back to documents"
            title="Back to documents"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1 className="text-xl font-semibold">{doc.title || doc.originalFilename || 'Untitled document'}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{isUploaded ? 'Uploaded file' : 'Created document'}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(!isUploaded || doc.mimeType === 'application/pdf') && (
            <form action={sendDocumentForSignatureAction.bind(null, doc.id)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 17c3 0 4-9 6-9s2 6 4 6 2-3 5-3" /><path d="M3 21h18" />
                </svg>
                Send for signature
              </button>
            </form>
          )}
          {!isUploaded && (
            <Link
              href={`/organizer/create?doc=${doc.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-zinc-900 dark:text-indigo-300"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              Edit
            </Link>
          )}
        </div>
      </header>

      <DocumentViewer
        id={doc.id}
        source={doc.source}
        kind={doc.kind}
        title={doc.title}
        body={doc.body}
        branding={branding}
        mimeType={doc.mimeType}
        originalFilename={doc.originalFilename}
        fileSize={doc.fileSize}
        signedUrl={signedUrl}
        initialBreakdown={doc.aiBreakdown}
        initialStale={breakdownStale}
        createdPreview={
          !isUploaded ? (
            <DocPreview kind={doc.kind as DocKind} title={doc.title} body={doc.body} branding={branding} />
          ) : null
        }
      />
    </div>
  );
}
