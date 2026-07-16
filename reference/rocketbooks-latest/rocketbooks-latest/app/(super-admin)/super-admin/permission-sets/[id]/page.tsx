import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  permissionSets,
  permissionSetPermissions,
  permissions,
  userPermissionSets,
  users,
} from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { PermissionSetEditor } from '../../_components/PermissionSetEditor';

export const dynamic = 'force-dynamic';

export default async function PermissionSetDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [set] = await db.select().from(permissionSets).where(eq(permissionSets.id, id)).limit(1);
  if (!set) notFound();

  const [keyRows, assignees] = await Promise.all([
    db
      .select({ key: permissions.key })
      .from(permissionSetPermissions)
      .innerJoin(permissions, eq(permissions.id, permissionSetPermissions.permissionId))
      .where(eq(permissionSetPermissions.permissionSetId, id)),
    db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        isActive: users.isActive,
      })
      .from(userPermissionSets)
      .innerJoin(users, eq(users.id, userPermissionSets.userId))
      .where(eq(userPermissionSets.permissionSetId, id))
      .orderBy(asc(users.email)),
  ]);

  const initialKeys = keyRows.map((r) => r.key);

  return (
    <AdminPage
      title={set.name}
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Permission Sets', href: '/super-admin/permission-sets' },
        { label: set.name },
      ]}
      actions={<Badge tone="blue">{initialKeys.length} permission{initialKeys.length === 1 ? '' : 's'}</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Overview" className="lg:col-span-1">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase text-zinc-500">Name</dt>
              <dd className="font-medium">{set.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-zinc-500">Description</dt>
              <dd>{set.description ?? <span className="text-zinc-400">—</span>}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-zinc-500">Created</dt>
              <dd>{set.createdAt ? new Date(set.createdAt).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-zinc-500">Updated</dt>
              <dd>{set.updatedAt ? new Date(set.updatedAt).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-zinc-500">Assigned users</dt>
              <dd>{assignees.length}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-zinc-500">ID</dt>
              <dd className="break-all font-mono text-xs text-zinc-500">{set.id}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Permissions" className="lg:col-span-2">
          <PermissionSetEditor setId={set.id} initialKeys={initialKeys} />
        </Panel>
      </div>

      <Panel title={`Assigned to (${assignees.length})`}>
        {assignees.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No users assigned to this permission set.
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {assignees.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-2">
                <div>
                  <span className="font-medium">{u.fullName ?? '—'}</span>
                  <span className="ml-2 text-xs text-zinc-500">{u.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'active' : 'inactive'}</Badge>
                  <Link
                    href={`/super-admin/all-users?q=${encodeURIComponent(u.email)}`}
                    className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                  >
                    View user →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminPage>
  );
}
