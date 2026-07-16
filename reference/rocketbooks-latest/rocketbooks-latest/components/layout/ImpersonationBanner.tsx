import { stopImpersonationAction } from '@/app/(super-admin)/super-admin/_actions/impersonate';
import { dismissImpersonationBannerAction } from '@/app/(app)/_actions/impersonation-banner';

interface Props {
  targetName: string;
  targetEmail: string;
  /** Started via the enterprise "Open books" flow — frame around the company. */
  openBooks?: boolean;
  companyName?: string;
}

export function ImpersonationBanner({ targetName, targetEmail, openBooks = false, companyName }: Props) {
  // "Open books" framing: the firm is working in a specific client company's
  // books. Blue, company-centric, with a "Close … Books" exit (logged) that
  // returns to the businesses list via the auto-stop handler.
  if (openBooks) {
    const co = companyName || 'this company';
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-300 bg-blue-50 px-6 py-2.5 text-sm dark:border-blue-900/60 dark:bg-blue-950/30">
        <div className="flex items-center gap-2 text-blue-900 dark:text-blue-200">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          <span>
            Working in <span className="font-semibold">{co}</span>&rsquo;s books · your access is logged
          </span>
        </div>
        <div className="flex items-center gap-1">
          <a
            href="/api/impersonation/auto-stop?reason=closed_books"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
          >
            {`Close "${co}" Books`}
          </a>
          <form action={dismissImpersonationBannerAction}>
            <button
              type="submit"
              aria-label="Dismiss banner"
              title="Dismiss for this session — stays in the top bar"
              className="rounded-md p-1.5 text-blue-900/70 hover:bg-blue-900/10 hover:text-blue-900 dark:text-blue-200/70 dark:hover:bg-blue-200/10 dark:hover:text-blue-200"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-300 bg-red-50 px-6 py-2.5 text-sm dark:border-red-900/60 dark:bg-red-950/30">
      <div className="flex items-center gap-2 text-red-900 dark:text-red-200">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
          <path d="M16 2l-4 4-4-4" />
        </svg>
        <span>
          <span className="font-semibold">Impersonating</span>{' '}
          {targetName} <span className="text-red-700/80 dark:text-red-300/80">({targetEmail})</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <form action={stopImpersonationAction}>
          <button
            type="submit"
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700"
          >
            Stop impersonating
          </button>
        </form>
        <form action={dismissImpersonationBannerAction}>
          <button
            type="submit"
            aria-label="Dismiss banner"
            title="Dismiss for this session — Impersonating stays in the top bar"
            className="rounded-md p-1.5 text-red-900/70 hover:bg-red-900/10 hover:text-red-900 dark:text-red-200/70 dark:hover:bg-red-200/10 dark:hover:text-red-200"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
