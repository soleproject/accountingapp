import { stopImpersonationAction } from '@/app/(super-admin)/super-admin/_actions/impersonate';

/**
 * Compact version of ImpersonationBanner, rendered in the TopBar while the
 * banner is dismissed. Keeps the active state always visible and one click
 * from exiting. In "Open books" mode it mirrors the banner: blue, company-
 * centric, exiting via the logged auto-stop handler.
 */
export function ImpersonationPill({
  targetName,
  targetEmail,
  openBooks = false,
  companyName,
}: {
  targetName: string;
  targetEmail: string;
  openBooks?: boolean;
  companyName?: string;
}) {
  if (openBooks) {
    const co = companyName || 'this company';
    return (
      <a
        href="/api/impersonation/auto-stop?reason=closed_books"
        title={`Working in ${co}'s books — click to close (your access is logged)`}
        className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <span className="max-w-[12rem] truncate">Working in {co}</span>
      </a>
    );
  }

  return (
    <form action={stopImpersonationAction}>
      <button
        type="submit"
        title={`Impersonating ${targetName} (${targetEmail}) — click to stop`}
        className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-red-700"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span className="max-w-[10rem] truncate">Impersonating {targetName}</span>
      </button>
    </form>
  );
}
