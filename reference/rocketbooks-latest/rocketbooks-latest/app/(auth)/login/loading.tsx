export default function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="mx-auto h-8 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        <div className="h-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      </div>
    </main>
  );
}
