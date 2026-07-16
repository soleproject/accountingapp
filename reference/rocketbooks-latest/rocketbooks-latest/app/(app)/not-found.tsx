import Link from 'next/link';

export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">404</span>
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        The record or page you were looking for doesn&apos;t exist in this organization.
      </p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
