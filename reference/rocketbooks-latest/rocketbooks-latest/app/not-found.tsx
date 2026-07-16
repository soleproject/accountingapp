import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">404</span>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          We couldn&apos;t find what you were looking for. It may have been moved or deleted.
        </p>
        <Link
          href="/dashboard"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
