import { eq, count, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { activityFeed, users } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 100;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function ActivityPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { page: pageStr } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);

  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(activityFeed).where(eq(activityFeed.orgId, orgId)),
    db
      .select({
        id: activityFeed.id,
        actor: activityFeed.actor,
        eventType: activityFeed.eventType,
        eventMetadata: activityFeed.eventMetadata,
        createdAt: activityFeed.createdAt,
        userEmail: users.email,
      })
      .from(activityFeed)
      .leftJoin(users, eq(activityFeed.userId, users.id))
      .where(eq(activityFeed.orgId, orgId))
      .orderBy(desc(activityFeed.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Activity Feed</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{(total?.n ?? 0).toLocaleString()} events</p>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">When</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">User</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Actor</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Event</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No activity yet.</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 whitespace-nowrap tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.userEmail ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.actor}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">{r.eventType}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-500">
                  {r.eventMetadata ? JSON.stringify(r.eventMetadata).slice(0, 80) + '…' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
