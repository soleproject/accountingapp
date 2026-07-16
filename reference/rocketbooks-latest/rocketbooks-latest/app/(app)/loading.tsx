export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-4 w-64 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
          ))}
        </div>
      </div>
    </div>
  );
}
