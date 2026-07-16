import { desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { adminAuditLog, users } from '@/db/schema/schema';
import { eq } from 'drizzle-orm';
import { isSuperAdmin } from '@/lib/auth/org';

const PAGE_SIZE = 100;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  if (!(await isSuperAdmin())) redirect('/dashboard');
  const { page: pageStr } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);

  const rows = await db
    .select({
      id: adminAuditLog.id,
      timestamp: adminAuditLog.timestamp,
      action: adminAuditLog.action,
      targetType: adminAuditLog.targetType,
      targetId: adminAuditLog.targetId,
      adminEmail: users.email,
    })
    .from(adminAuditLog)
    .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
    .orderBy(desc(adminAuditLog.timestamp))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Admin Audit Log</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Latest admin actions across the platform · super-admin only</p>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Time</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Admin</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Action</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Target</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Target ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  No audit entries.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.adminEmail ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.action}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.targetType}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-500">{r.targetId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav className="flex items-center gap-2 text-sm">
        {page > 1 && <a href={`?page=${page - 1}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">← Previous</a>}
        {rows.length === PAGE_SIZE && <a href={`?page=${page + 1}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Next →</a>}
      </nav>
    </div>
  );
}
