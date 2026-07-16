'use client';

import { useEffect } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error boundary:', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-800 dark:bg-red-900/20">
      <h1 className="text-lg font-semibold text-red-900 dark:text-red-100">Something went wrong</h1>
      <p className="text-sm text-red-800 dark:text-red-200">
        {error.message || 'An unexpected error occurred'}
        {error.digest && (
          <span className="ml-2 font-mono text-xs text-red-700 dark:text-red-300">
            (id: {error.digest})
          </span>
        )}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-red-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 dark:bg-red-100 dark:text-red-900 dark:hover:bg-white"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
        >
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
