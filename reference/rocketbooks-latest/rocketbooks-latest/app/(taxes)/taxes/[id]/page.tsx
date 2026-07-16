import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getTaxReturnDetail } from '@/lib/tax/store';
import { getTaxPdfSignedUrl } from '@/lib/tax/storage';
import { TaxReturnWorkspace } from '../_components/TaxReturnWorkspace';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TaxReturnPage({ params }: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  const detail = await getTaxReturnDetail(orgId, id);
  if (!detail) notFound();

  // Resolve a signed URL for each filled draft PDF so the workspace can link to them
  // (the tax-forms bucket is private).
  const pdfUrls: Record<string, string> = {};
  await Promise.all(
    detail.forms
      .filter((f) => f.filledPdfPath)
      .map(async (f) => {
        const url = await getTaxPdfSignedUrl(f.filledPdfPath!);
        if (url) pdfUrls[f.id] = url;
      }),
  );

  const back = (
    <Link href="/taxes" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      Tax Returns
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">{back}</header>
      <TaxReturnWorkspace detail={detail} pdfUrls={pdfUrls} />
    </div>
  );
}
