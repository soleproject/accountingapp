import Link from 'next/link';
import { sql, desc, eq, gte, count } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseStaff,
  adminAuditLog,
  aiAuditActions,
  jobs,
} from '@/db/schema/schema';
import { AdminPage, MetricTile, Panel, EmptyHint, StatusDot } from '@/components/admin/AdminPage';
import { timeDb } from '@/lib/perf/db-timing';

export const dynamic = 'force-dynamic';

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default async function SuperAdminDashboardPage() {
  // eslint-disable-next-line react-hooks/purity -- server component; per-request "now" is required for dashboard windows.
  const nowMs = Date.now();
  const weekAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();

  const timingContext = { route: '/super-admin/dashboard' };
  const [
    [totalUsers],
    [totalEnterprises],
    [activeSubs],
    [newUsersWeek],
    [newEnterprisesMonth],
    [aiUsage],
    recentActivity,
  ] = await Promise.all([
    timeDb('superAdmin.dashboard.totalUsers', () => db.select({ n: count() }).from(users), timingContext),
    timeDb(
      'superAdmin.dashboard.totalEnterprises',
      () => db.select({ n: sql<number>`count(distinct ${enterpriseStaff.enterpriseId})` }).from(enterpriseStaff),
      timingContext,
    ),
    timeDb(
      'superAdmin.dashboard.activeSubscriptions',
      () => db.select({ n: count() }).from(organizations).where(sql`${organizations.planType} <> 'free'`),
      timingContext,
    ),
    timeDb('superAdmin.dashboard.newUsersWeek', () => db.select({ n: count() }).from(users).where(gte(users.createdAt, weekAgo)), timingContext),
    timeDb(
      'superAdmin.dashboard.newEnterprisesMonth',
      () =>
        db
          .select({ n: sql<number>`count(distinct ${enterpriseStaff.enterpriseId})` })
          .from(enterpriseStaff)
          .innerJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
          .where(gte(organizations.createdAt, monthAgo)),
      timingContext,
    ),
    timeDb('superAdmin.dashboard.aiAuditCount', () => db.select({ n: count() }).from(aiAuditActions), timingContext),
    timeDb(
      'superAdmin.dashboard.recentActivity',
      () =>
        db
          .select({
            id: adminAuditLog.id,
            action: adminAuditLog.action,
            targetType: adminAuditLog.targetType,
            targetId: adminAuditLog.targetId,
            timestamp: adminAuditLog.timestamp,
            adminEmail: users.email,
          })
          .from(adminAuditLog)
          .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
          .orderBy(desc(adminAuditLog.timestamp))
          .limit(8),
      timingContext,
    ),
  ]);

  // Live system health from jobs table (read-only — no effect on processing).
  const [[pendingJobs], [runningJobs], [failedJobsHour]] = await Promise.all([
    timeDb('superAdmin.dashboard.pendingJobs', () => db.select({ n: count() }).from(jobs).where(sql`${jobs.status} = 'PENDING'`), timingContext),
    timeDb('superAdmin.dashboard.runningJobs', () => db.select({ n: count() }).from(jobs).where(sql`${jobs.status} = 'RUNNING'`), timingContext),
    timeDb(
      'superAdmin.dashboard.failedJobsHour',
      () =>
        db
          .select({ n: count() })
          .from(jobs)
          .where(sql`${jobs.status} = 'ERROR' and ${jobs.createdAt} >= ${new Date(nowMs - 60 * 60 * 1000).toISOString()}`),
      timingContext,
    ),
  ]);

  const queueLength = (pendingJobs?.n ?? 0) + (runningJobs?.n ?? 0);
  const jobsStatus: 'ok' | 'warn' | 'error' = (failedJobsHour?.n ?? 0) > 5 ? 'error' : (failedJobsHour?.n ?? 0) > 0 ? 'warn' : 'ok';
  const queueStatus: 'ok' | 'warn' | 'error' = queueLength > 100 ? 'warn' : 'ok';

  return (
    <AdminPage title="SuperAdmin Dashboard" crumbs={[{ label: 'SuperAdmin' }, { label: 'Dashboard' }]}>
      {/* Top row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Total Enterprises"
          value={totalEnterprises?.n ?? 0}
          iconColor="text-blue-600 dark:text-blue-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="1" />
              <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
            </svg>
          }
        />
        <MetricTile
          label="Total Users"
          value={totalUsers?.n ?? 0}
          iconColor="text-violet-600 dark:text-violet-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
            </svg>
          }
        />
        <MetricTile
          label="Active Subscriptions"
          value={activeSubs?.n ?? 0}
          iconColor="text-emerald-600 dark:text-emerald-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          }
        />
        <MetricTile
          label="Monthly Revenue"
          value="$0"
          iconColor="text-amber-600 dark:text-amber-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />
      </div>

      {/* Second row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="New Users This Week" value={newUsersWeek?.n ?? 0} delta={{ value: '0%', positive: true }} />
        <MetricTile label="New Enterprises This Month" value={newEnterprisesMonth?.n ?? 0} delta={{ value: '0%', positive: true }} />
        <MetricTile label="Failed Logins" value={0} delta={{ value: '0%', positive: true }} />
        <MetricTile label="AI Usage (Requests)" value={aiUsage?.n ?? 0} delta={{ value: '0%', positive: true }} />
      </div>

      {/* Third row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Recent Activity">
          {recentActivity.length === 0 ? (
            <EmptyHint>No recent activity</EmptyHint>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {recentActivity.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.action}</div>
                    <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {r.adminEmail ?? 'system'} · {r.targetType}
                      {r.targetId ? ` · ${r.targetId.slice(0, 8)}…` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{fmtTimeAgo(r.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Quick Actions">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link
              href="/super-admin/enterprises"
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-zinc-200 p-4 text-center text-sm transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-zinc-800 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
            >
              <svg className="text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="2" width="16" height="20" rx="1" />
                <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01" />
              </svg>
              <span>Create Enterprise</span>
            </Link>
            <Link
              href="/super-admin/admin"
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-zinc-200 p-4 text-center text-sm transition-colors hover:border-violet-300 hover:bg-violet-50 dark:border-zinc-800 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              <svg className="text-violet-600 dark:text-violet-400" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
              </svg>
              <span>Add Admin</span>
            </Link>
            <Link
              href="/super-admin/activity-log"
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-zinc-200 p-4 text-center text-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-zinc-800 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/30"
            >
              <svg className="text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span>View Logs</span>
            </Link>
            <Link
              href="/super-admin/settings"
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-zinc-200 p-4 text-center text-sm transition-colors hover:border-rose-300 hover:bg-rose-50 dark:border-zinc-800 dark:hover:border-rose-700 dark:hover:bg-rose-950/30"
            >
              <svg className="text-rose-600 dark:text-rose-400" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9" />
              </svg>
              <span>Settings</span>
            </Link>
          </div>
        </Panel>
      </div>

      {/* System health */}
      <Panel title="System Health">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Database</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">Connected <StatusDot status="ok" /></div>
          </div>
          <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Background Jobs (failed/hr)</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">{failedJobsHour?.n ?? 0} <StatusDot status={jobsStatus} /></div>
          </div>
          <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Queue Length</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">{queueLength} <StatusDot status={queueStatus} /></div>
            <div className="text-xs text-zinc-500">{pendingJobs?.n ?? 0} pending · {runningJobs?.n ?? 0} running</div>
          </div>
          <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Storage</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">OK <StatusDot status="ok" /></div>
          </div>
        </div>
      </Panel>
    </AdminPage>
  );
}
