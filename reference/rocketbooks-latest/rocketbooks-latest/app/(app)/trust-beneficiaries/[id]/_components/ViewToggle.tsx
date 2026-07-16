import Link from 'next/link';

interface Props {
  current: 'lines' | 'txns';
  /** Existing query string (without "?"), so the toggle preserves filters. */
  preservedQuery: string;
}

/**
 * Segmented toggle between the per-line table and the per-transaction
 * card list. Both views respect the current filters — we just swap how
 * the rows are laid out.
 */
export function ViewToggle({ current, preservedQuery }: Props) {
  const buildHref = (v: 'lines' | 'txns') => {
    const params = new URLSearchParams(preservedQuery);
    params.set('view', v);
    return `?${params.toString()}`;
  };

  const cls = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm font-medium transition-colors ${
      active
        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
        : 'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
    }`;

  return (
    <div className="flex items-center gap-1">
      <Link href={buildHref('lines')} className={cls(current === 'lines')}>
        Lines
      </Link>
      <Link href={buildHref('txns')} className={cls(current === 'txns')}>
        Transactions
      </Link>
    </div>
  );
}
