'use client';

import { useRouter } from 'next/navigation';

/**
 * Opens the tour-picker takeover (cool tour vs platform tour). Lives in the
 * TopBar so it's reachable from any page in the app. The full "Hello,
 * welcome to RocketBooks" welcome experience lives behind Settings →
 * Replay welcome -- this button is specifically the tour entry point.
 */
export function TourButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => router.push('/dashboard?tour=pick')}
      className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      aria-label="Pick a tour"
      title="Tour"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
      Tour
    </button>
  );
}
