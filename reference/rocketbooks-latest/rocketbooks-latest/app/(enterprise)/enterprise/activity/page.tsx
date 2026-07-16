import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminAuditLog, users } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function EnterpriseActivityPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

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
    .where(eq(adminAuditLog.targetId, current.id))
    .orderBy(desc(adminAuditLog.timestamp))
    .limit(100);

  return (
    <AdminPage
      title="Activity"
      crumbs={[{ label: 'Enterprise' }, { label: 'Activity' }]}
    >
      <Panel>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Recent activity scoped to {current.name}
        </p>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">Admin</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-zinc-500">
                    No activity for this enterprise yet.
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
