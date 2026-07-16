import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getRequestForOwner } from '@/lib/signatures/store';
import { getSignatureSignedUrl } from '@/lib/storage/signatures';
import { SignatureBuilder } from '../_components/SignatureBuilder';
import { RequestStatus } from '../_components/RequestStatus';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SignatureRequestPage({ params }: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  const data = await getRequestForOwner(orgId, id);
  if (!data) notFound();
  const { request, recipients, fields } = data;

  const backLink = (
    <Link href="/organizer/signatures" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      Signatures
    </Link>
  );

  if (request.status === 'draft') {
    const pdfUrl = request.sourcePdfPath ? await getSignatureSignedUrl(request.sourcePdfPath).catch(() => null) : null;
    return (
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          {backLink}
          <h1 className="text-xl font-semibold">Prepare for signature</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Add recipients, place fields, then send.</p>
        </header>
        {pdfUrl ? (
          <SignatureBuilder
            requestId={request.id}
            pdfUrl={pdfUrl}
            initialTitle={request.title}
            initialMessage={request.message}
            initialSequential={request.sequential}
            initialRecipients={recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone ?? '' }))}
            initialFields={fields.map((f) => ({ id: f.id, recipientId: f.recipientId, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type, required: f.required }))}
          />
        ) : (
          <p className="text-sm text-rose-600">The source document is missing — start a new request.</p>
        )}
      </div>
    );
  }

  // Sent / completed / declined / voided — tracking view.
  const completedUrl = request.completedPdfPath ? await getSignatureSignedUrl(request.completedPdfPath).catch(() => null) : null;
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        {backLink}
        <h1 className="text-xl font-semibold">{request.title || 'Signature request'}</h1>
      </header>
      <RequestStatus request={request} recipients={recipients} completedUrl={completedUrl} />
    </div>
  );
}
