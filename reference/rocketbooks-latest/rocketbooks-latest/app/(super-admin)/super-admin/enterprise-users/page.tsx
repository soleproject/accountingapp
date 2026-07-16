import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseStaff, users, organizations } from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

export default async function EnterpriseUsersPage() {
  const rows = await db
    .select({
      id: enterpriseStaff.id,
      role: enterpriseStaff.role,
      createdAt: enterpriseStaff.createdAt,
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      enterpriseId: organizations.id,
      enterpriseName: organizations.name,
    })
    .from(enterpriseStaff)
    .leftJoin(users, eq(users.id, enterpriseStaff.staffUserId))
    .leftJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
    .orderBy(desc(enterpriseStaff.createdAt));

  return (
    <AdminPage
      title="Enterprise Users"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Enterprise Users' }]}
    >
      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Enterprise</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last Login</th>
                <th className="px-4 py-2.5">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                    No enterprise users yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5 font-medium">{r.fullName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{r.email}</td>
                    <td className="px-4 py-2.5">
                      {r.enterpriseId ? (
                        <Link href={`/super-admin/enterprises/${r.enterpriseId}`} className="text-blue-700 hover:underline dark:text-blue-300">
                          {r.enterpriseName ?? r.enterpriseId.slice(0, 8)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone="blue">{r.role}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={r.isActive ? 'green' : 'red'}>{r.isActive ? 'active' : 'inactive'}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Showing {rows.length} {rows.length === 1 ? 'user' : 'users'}
        </div>
      </Panel>
    </AdminPage>
  );
}
