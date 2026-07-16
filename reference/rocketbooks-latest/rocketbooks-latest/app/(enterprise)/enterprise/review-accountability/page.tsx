import { redirect } from 'next/navigation';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { loadClientReviewAccountability } from '@/lib/enterprise/review-accountability';
import { requestClientReviewForOrg } from './_actions/requestReview';

/**
 * Firm-level review accountability — the chase list. Which clients have
 * transactions waiting in their review queue, how stale, and when we last asked
 * them to help. One-click "Request input" nudges that client (reuses the
 * per-org review-request outreach). Gated by the (enterprise) layout.
 */
export default async function ReviewAccountabilityPage() {
  const enterprise = await getCurrentEnterprise();
  if (!enterprise) redirect('/dashboard');

  const rows = await loadClientReviewAccountability(enterprise.id);
  const needsAttention = rows.filter((r) => r.pendingCount > 0);
  const caughtUp = rows.length - needsAttention.length;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Review accountability</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Clients with transactions waiting for review — push the ones who&apos;ve stalled.
        </p>
      </header>

      <div className="flex gap-3 text-sm">
        <span className="rounded-md bg-amber-100 px-3 py-1 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {needsAttention.length} need attention
        </span>
        <span className="rounded-md bg-emerald-100 px-3 py-1 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
          {caughtUp} caught up
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Client</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Pending</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Oldest</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Last request</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {needsAttention.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  All clients are caught up on review. ✓
                </td>
              </tr>
            )}
            {needsAttention.map((r) => {
              const stale = (r.oldestDays ?? 0) >= 7;
              return (
                <tr key={r.orgId} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                  <td className="px-4 py-2">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.orgName}</div>
                    {r.ownerEmail && <div className="text-xs text-zinc-500">{r.ownerEmail}</div>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">{r.pendingCount}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${stale ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
                    {r.oldestDays != null ? `${r.oldestDays}d${stale ? ' ⚠' : ''}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {r.lastRequestAt ? (
                      <span title={r.lastRequestStatus ?? undefined}>{r.lastRequestAt.slice(0, 10)}</span>
                    ) : (
                      <span className="text-zinc-400">never asked</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={requestClientReviewForOrg}>
                      <input type="hidden" name="orgId" value={r.orgId} />
                      <button
                        type="submit"
                        className="rounded-md border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
                      >
                        Request input
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-400">
        “Request input” emails the client (and texts them if they&apos;ve opted in) a link to their review queue.
        Limited to once every 24 hours per client.
      </p>
    </div>
  );
}
