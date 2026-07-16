import Link from 'next/link';
import { eq, and, count, desc, sql, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { TaskRow } from './_components/TaskRow';

const PAGE_SIZE = 50;

type StatusFilter = 'all' | 'open' | 'done';

interface PageProps {
  searchParams: Promise<{ page?: string; status?: string }>;
}

export default async function OrganizerTasksPage({ searchParams }: PageProps) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status: StatusFilter =
    sp.status === 'open' || sp.status === 'done' || sp.status === 'all' ? sp.status : 'all';

  // user_id scope makes this a personal-task view (the org-wide view
  // already exists at /tasks in the accounting workspace). status filter
  // pushes down to SQL so pagination and counts stay consistent.
  // In the read-only demo org the data is shared (seeded under the demo
  // system user), so drop the user filter and show the whole org — mirrors
  // how the accounting demo is org-scoped.
  const baseWhere = and(
    eq(tasks.organizationId, orgId),
    isDemoOrg(orgId) ? undefined : eq(tasks.userId, userId),
  );
  const where =
    status === 'open'
      ? and(baseWhere, eq(tasks.status, 'OPEN'))
      : status === 'done'
        ? and(baseWhere, eq(tasks.status, 'DONE'))
        : baseWhere;

  const [[total], rows, [statusCounts]] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(where),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        module: tasks.module,
        priority: tasks.priority,
        status: tasks.status,
        dueDate: tasks.dueDate,
        page: tasks.page,
      })
      .from(tasks)
      .where(where)
      .orderBy(
        // Open tasks first, then by due date soonest, then most recent.
        // Filter pills shortcut to a single status, so this only matters
        // when the user is viewing "all".
        sql`${tasks.status} = 'DONE'`,
        sql`${tasks.dueDate} IS NULL`,
        asc(tasks.dueDate),
        desc(tasks.createdAt),
      )
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({
        all: sql<number>`COUNT(*)::int`.as('all'),
        open: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'OPEN')::int`.as('open'),
        done: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'DONE')::int`.as('done'),
      })
      .from(tasks)
      .where(baseWhere),
  ]);

  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const buildHref = (overrides: { page?: number; status?: StatusFilter }) => {
    const parts: string[] = [];
    const p = overrides.page ?? page;
    if (p > 1) parts.push(`page=${p}`);
    const s = overrides.status ?? status;
    if (s !== 'all') parts.push(`status=${s}`);
    return parts.length === 0 ? '?' : `?${parts.join('&')}`;
  };

  const VALID_STATUSES: StatusFilter[] = ['all', 'open', 'done'];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {totalCount.toLocaleString()} {status === 'all' ? 'total' : status} · Page {page} of {pageCount}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          {VALID_STATUSES.map((s) => {
            const counts = statusCounts ?? { all: 0, open: 0, done: 0 };
            const n = counts[s];
            const active = status === s;
            return (
              <Link
                key={s}
                href={buildHref({ status: s, page: 1 })}
                className={`rounded px-2 py-1 ${
                  active
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                }`}
              >
                {s} <span className="opacity-60">({n})</span>
              </Link>
            );
          })}
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="w-24 px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Status</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Title</th>
              <th className="w-32 px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Module</th>
              <th className="w-24 px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Priority</th>
              <th className="w-32 px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Due</th>
              <th className="w-32 px-4 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  No tasks on this page.
                </td>
              </tr>
            )}
            {rows.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <nav className="flex items-center gap-2 text-sm">
          {page > 1 && (
            <Link
              href={buildHref({ page: page - 1 })}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              ← Previous
            </Link>
          )}
          {page < pageCount && (
            <Link
              href={buildHref({ page: page + 1 })}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Next →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
