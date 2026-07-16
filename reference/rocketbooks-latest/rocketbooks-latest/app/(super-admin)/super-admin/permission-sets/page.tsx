import Link from 'next/link';
import { sql, eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { permissionSets, permissionSetPermissions } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { deletePermissionSetAction } from '../_actions/admin';

export const dynamic = 'force-dynamic';

export default async function PermissionSetsPage() {
  const countSq = db.$with('cnt').as(
    db
      .select({ psid: permissionSetPermissions.permissionSetId, n: sql<number>`count(*)::int`.as('n') })
      .from(permissionSetPermissions)
      .groupBy(permissionSetPermissions.permissionSetId),
  );

  const rows = await db
    .with(countSq)
    .select({
      id: permissionSets.id,
      name: permissionSets.name,
      description: permissionSets.description,
      permissionCount: sql<number>`coalesce(${countSq.n}, 0)`.as('permission_count'),
    })
    .from(permissionSets)
    .leftJoin(countSq, eq(countSq.psid, permissionSets.id))
    .orderBy(asc(permissionSets.name));

  return (
    <AdminPage
      title="Permission Sets"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Permission Sets' }]}
      actions={
        <Link href="/super-admin/permission-sets/new" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
          + Create Permission Set
        </Link>
      }
    >
      <Panel>
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5 text-right">Permissions</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-zinc-500">No permission sets defined.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5">
                      <Link href={`/super-admin/permission-sets/${r.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{r.description ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(r.permissionCount)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Link href={`/super-admin/permission-sets/${r.id}`} className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                          View
                        </Link>
                        <form action={deletePermissionSetAction} className="inline">
                          <input type="hidden" name="id" value={r.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Showing {rows.length} permission {rows.length === 1 ? 'set' : 'sets'}
        </div>
      </Panel>
    </AdminPage>
  );
}
