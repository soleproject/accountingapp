import { openClientBooksAction } from '../_actions/openBooks';

/**
 * Opens a specific client company's books as the firm (impersonate + set active
 * company). The access is logged. `compact` renders a small inline button for
 * table rows; otherwise a prominent primary button.
 */
export function OpenBooksButton({ userId, orgId, compact = false }: { userId: string; orgId: string; compact?: boolean }) {
  return (
    <form action={openClientBooksAction} className="inline">
      <input type="hidden" name="targetUserId" value={userId} />
      <input type="hidden" name="orgId" value={orgId} />
      <button
        type="submit"
        title="Open this company's books (your access is logged)"
        className={
          compact
            ? 'inline-flex items-center gap-1 rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30'
            : 'inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700'
        }
      >
        <svg viewBox="0 0 24 24" width={compact ? 13 : 15} height={compact ? 13 : 15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        Open books
      </button>
    </form>
  );
}
