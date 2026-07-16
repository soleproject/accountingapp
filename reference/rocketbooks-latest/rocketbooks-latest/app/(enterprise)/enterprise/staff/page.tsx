import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseStaff, users } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { requireSession } from '@/lib/auth/session';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { notFound } from 'next/navigation';
import { StaffRowActions } from './_components/StaffRowActions';

export const dynamic = 'force-dynamic';

export default async function EnterpriseStaffPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  // Only the enterprise owner or a super admin may archive/remove staff. The
  // server actions re-check this before mutating; here it just gates the UI.
  const session = await requireSession();
  const canManage = current.role === 'owner' || current.role === 'super_admin';

  const rows = await db
    .select({
      id: enterpriseStaff.id,
      role: enterpriseStaff.role,
      createdAt: enterpriseStaff.createdAt,
      archivedAt: enterpriseStaff.archivedAt,
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
    })
    .from(enterpriseStaff)
    .leftJoin(users, eq(users.id, enterpriseStaff.staffUserId))
    .where(eq(enterpriseStaff.enterpriseId, current.id))
    .orderBy(desc(enterpriseStaff.createdAt));

  return (
    <AdminPage
      title="Staff"
      crumbs={[{ label: 'Enterprise' }, { label: 'Staff' }]}
    >
      <Panel>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Staff members at {current.name}
        </p>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last Login</th>
                <th className="px-4 py-2.5">Joined</th>
                {canManage && <th className="px-4 py-2.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 7 : 6} className="px-4 py-12 text-center text-zinc-500">
                    No staff for this enterprise yet.
                  </td>
                </tr>
              ) : (
                rows.map((s) => (
                  <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5 font-medium">{s.fullName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{s.email}</td>
                    <td className="px-4 py-2.5"><Badge tone="blue">{s.role}</Badge></td>
                    <td className="px-4 py-2.5">
                      {s.archivedAt ? (
                        <Badge tone="zinc">archived</Badge>
                      ) : (
                        <Badge tone={s.isActive ? 'green' : 'red'}>{s.isActive ? 'active' : 'inactive'}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5">
                        {s.userId === session.id ? (
                          <span className="block text-right text-xs text-zinc-400">You</span>
                        ) : (
                          <StaffRowActions
                            staffId={s.id}
                            archived={!!s.archivedAt}
                            name={s.fullName ?? s.email ?? 'this staff member'}
                          />
                        )}
                      </td>
                    )}
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
