import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, organizations, enterpriseClients } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { setFirmTaskStatusAction } from '../_actions/recurringTasks';

export const dynamic = 'force-dynamic';

type StatusFilter = 'OPEN' | 'DONE' | 'all';

export default async function EnterpriseWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) notFound();
  const { status } = await searchParams;
  const statusFilter: StatusFilter = status === 'DONE' ? 'DONE' : status === 'all' ? 'all' : 'OPEN';

  // Client orgs of this enterprise → the orgs whose firm-recurring tasks we own.
  const clientLinks = await db
    .select({ clientUserId: enterpriseClients.clientUserId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.enterpriseId, current.id));
  const clientUserIds = Array.from(new Set(clientLinks.map((c) => c.clientUserId).filter(Boolean)));

  const clientOrgs = clientUserIds.length
    ? await db
        .select({ id: organizations.id, name: organizations.name, ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(inArray(organizations.ownerUserId, clientUserIds))
    : [];
  const orgIds = clientOrgs.map((o) => o.id);
  const orgById = new Map(clientOrgs.map((o) => [o.id, o]));

  const rows = orgIds.length
    ? await db
        .select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          dueDate: tasks.dueDate,
          status: tasks.status,
          organizationId: tasks.organizationId,
        })
        .from(tasks)
        .where(
          and(
            inArray(tasks.organizationId, orgIds),
            eq(tasks.source, 'recurring'),
            eq(tasks.category, 'firm'),
            ...(statusFilter === 'all' ? [] : [eq(tasks.status, statusFilter)]),
          ),
        )
        .orderBy(desc(tasks.status), asc(tasks.dueDate))
        .limit(500)
    : [];

  const now = Date.now();

  return (
    <AdminPage
      title="Work"
      crumbs={[{ label: 'Enterprise' }, { label: 'Work' }]}
    >
      <Panel>
        <div className="mb-4 flex items-end justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Your firm&apos;s recurring tasks across all clients ({rows.length})
          </p>
          <div className="flex gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            {(['OPEN', 'DONE', 'all'] as StatusFilter[]).map((s) => (
              <Link
                key={s}
                href={`?${s === 'OPEN' ? '' : `status=${s}`}`}
                className={`rounded px-2 py-1 ${
                  statusFilter === s
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                }`}
              >
                {s === 'all' ? 'all' : s.toLowerCase()}
              </Link>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-300 px-4 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No firm tasks{statusFilter === 'OPEN' ? ' open' : ''}. Generate them from a client&apos;s{' '}
            <span className="font-medium">Edit business → Generate tasks</span>.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2.5">Task</th>
                  <th className="px-4 py-2.5">Client</th>
                  <th className="px-4 py-2.5">Due</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const org = r.organizationId ? orgById.get(r.organizationId) : undefined;
                  const due = r.dueDate ? new Date(r.dueDate) : null;
                  const overdue = !!due && r.status === 'OPEN' && due.getTime() < now;
                  const isOpen = r.status === 'OPEN';
                  return (
                    <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{r.title}</div>
                        {r.description && (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">{r.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {org ? (
                          <Link
                            href={`/enterprise/clients/${org.ownerUserId}/bookkeeping`}
                            className="text-blue-700 hover:underline dark:text-blue-300"
                          >
                            {org.name}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {due ? (
                          <span className={overdue ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-zinc-600 dark:text-zinc-400'}>
                            {due.toLocaleDateString()}
                            {overdue ? ' · overdue' : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!isOpen && <Badge tone="green">Done</Badge>}
                          <form action={setFirmTaskStatusAction}>
                            <input type="hidden" name="taskId" value={r.id} />
                            <input type="hidden" name="status" value={isOpen ? 'DONE' : 'OPEN'} />
                            <button
                              type="submit"
                              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                                isOpen
                                  ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
                                  : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900'
                              }`}
                            >
                              {isOpen ? 'Mark done' : 'Reopen'}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}
