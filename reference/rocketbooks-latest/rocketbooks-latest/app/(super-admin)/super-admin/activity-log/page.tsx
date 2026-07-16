import Link from 'next/link';
import { desc, eq, and, ilike, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminAuditLog, users } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface SearchParams {
  page?: string;
  action?: string;
  targetType?: string;
  adminId?: string;
  from?: string;
  to?: string;
}

function buildHref(base: SearchParams, override: Partial<SearchParams>): string {
  const merged = { ...base, ...override };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== '') p.set(k, String(v));
  }
  const qs = p.toString();
  return qs ? `/super-admin/activity-log?${qs}` : '/super-admin/activity-log';
}

export default async function ActivityLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const action = (sp.action ?? '').trim();
  const targetType = (sp.targetType ?? '').trim();
  const adminId = (sp.adminId ?? '').trim();
  const from = (sp.from ?? '').trim();
  const to = (sp.to ?? '').trim();

  const conds: ReturnType<typeof eq>[] = [];
  if (action) conds.push(eq(adminAuditLog.action, action));
  if (targetType) conds.push(eq(adminAuditLog.targetType, targetType));
  if (adminId) conds.push(eq(adminAuditLog.adminUserId, adminId));
  if (from) conds.push(gte(adminAuditLog.timestamp, `${from}T00:00:00`));
  if (to) conds.push(lte(adminAuditLog.timestamp, `${to}T23:59:59`));

  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const baseQ = db
    .select({
      id: adminAuditLog.id,
      timestamp: adminAuditLog.timestamp,
      action: adminAuditLog.action,
      targetType: adminAuditLog.targetType,
      targetId: adminAuditLog.targetId,
      auditMetadata: adminAuditLog.auditMetadata,
      adminEmail: users.email,
    })
    .from(adminAuditLog)
    .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
    .orderBy(desc(adminAuditLog.timestamp));

  const filtered = whereClause ? baseQ.where(whereClause) : baseQ;

  const [rows, distinctActions, distinctTargets, recentAdmins] = await Promise.all([
    filtered.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db
      .selectDistinct({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .orderBy(adminAuditLog.action),
    db
      .selectDistinct({ targetType: adminAuditLog.targetType })
      .from(adminAuditLog)
      .orderBy(adminAuditLog.targetType),
    db
      .selectDistinct({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
      })
      .from(adminAuditLog)
      .innerJoin(users, eq(users.id, adminAuditLog.adminUserId))
      .orderBy(users.email)
      .limit(50),
  ]);

  void ilike;
  void sql;
  const hasFilters = action || targetType || adminId || from || to;

  return (
    <AdminPage
      title="Activity Log"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Activity Log' }]}
    >
      <Panel>
        <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase text-zinc-500">Action</span>
            <select name="action" defaultValue={action} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">All</option>
              {distinctActions.map((a) => (
                <option key={a.action} value={a.action}>{a.action}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase text-zinc-500">Target type</span>
            <select name="targetType" defaultValue={targetType} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">All</option>
              {distinctTargets.map((t) => (
                <option key={t.targetType} value={t.targetType}>{t.targetType}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase text-zinc-500">Admin</span>
            <select name="adminId" defaultValue={adminId} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">All</option>
              {recentAdmins.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName ?? u.email}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase text-zinc-500">From</span>
            <input type="date" name="from" defaultValue={from} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase text-zinc-500">To</span>
            <input type="date" name="to" defaultValue={to} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
          </label>
          <div className="flex items-end gap-2 lg:col-span-5">
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Apply
            </button>
            {hasFilters && (
              <Link
                href="/super-admin/activity-log"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Reset
              </Link>
            )}
          </div>
        </form>
      </Panel>

      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">Admin</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Target Type</th>
                <th className="px-4 py-2.5">Target ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                    {hasFilters ? 'No activity matches these filters.' : 'No activity yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                      {r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.adminEmail ?? '—'}</td>
                    <td className="px-4 py-2 font-medium">{r.action}</td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.targetType}</td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">{r.targetId ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <nav className="mt-3 flex items-center justify-end gap-2 text-sm">
          {page > 1 && (
            <Link
              href={buildHref(sp, { page: String(page - 1) })}
              className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              ← Previous
            </Link>
          )}
          {rows.length === PAGE_SIZE && (
            <Link
              href={buildHref(sp, { page: String(page + 1) })}
              className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Next →
            </Link>
          )}
        </nav>
      </Panel>
    </AdminPage>
  );
}
