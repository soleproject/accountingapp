import { desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.role, ['admin', 'super_admin', 'superadmin']))
    .orderBy(desc(users.createdAt));

  const supers = rows.filter((r) => r.role === 'super_admin' || r.role === 'superadmin');
  const admins = rows.filter((r) => r.role === 'admin');

  return (
    <AdminPage
      title="Admin"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Admin' }]}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`Super Admins (${supers.length})`}>
          {supers.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              No super admins.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {supers.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{u.fullName ?? '—'}</div>
                    <div className="text-xs text-zinc-500">{u.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'active' : 'inactive'}</Badge>
                    <Badge tone="red">{u.role}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Admins (${admins.length})`}>
          {admins.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              No admins.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {admins.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{u.fullName ?? '—'}</div>
                    <div className="text-xs text-zinc-500">{u.email}</div>
                  </div>
                  <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'active' : 'inactive'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AdminPage>
  );
}
