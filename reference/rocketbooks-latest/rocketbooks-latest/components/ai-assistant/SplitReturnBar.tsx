'use client';

/**
 * Pinned bar at the bottom of the sidecar while the user is on the split screen
 * they reached from a guided deposit review — the model proved unreliable at
 * navigating back when the user said "skip", so this takes it out of its hands.
 * "Done" returns to the same spot (a saved split has left the queue, so that
 * index is the next deposit); "Back to review" skips PAST the current deposit
 * (advances the guide index) so an unsaved one doesn't re-appear.
 */
export function SplitReturnBar({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-900 dark:bg-indigo-950/40">
        <span className="text-xs font-medium text-indigo-900 dark:text-indigo-200">Splitting this deposit</span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ← Skip &amp; back
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
          >
            ✓ Done
          </button>
        </div>
      </div>
    </div>
  );
}
