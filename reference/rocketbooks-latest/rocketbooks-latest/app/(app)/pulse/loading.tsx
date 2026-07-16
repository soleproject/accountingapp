export default function PulseLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="h-7 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-2 h-3 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-44 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-8 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-8 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
        ))}
      </div>

      <div className="h-80 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
        <div className="h-64 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
        <div className="h-56 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
      </div>

      <div className="h-64 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
    </div>
  );
}
