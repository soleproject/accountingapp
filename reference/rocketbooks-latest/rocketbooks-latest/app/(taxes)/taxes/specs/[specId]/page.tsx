import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getSpecReviewData } from '@/lib/tax/review';
import { SpecReview } from '../../_components/SpecReview';

interface PageProps {
  params: Promise<{ specId: string }>;
}

/** Preparer review of a learned FormSpec — inspect the AI's field mappings + dependency
 *  graph, then promote it up the trust ladder. Specs are global knowledge (verifying one
 *  helps every org), so this page isn't org-scoped — but it requires a session. */
export default async function SpecReviewPage({ params }: PageProps) {
  await requireSession();
  const { specId } = await params;

  const data = await getSpecReviewData(specId);
  if (!data) notFound();

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
      <SpecReview data={data} />
    </div>
  );
}
