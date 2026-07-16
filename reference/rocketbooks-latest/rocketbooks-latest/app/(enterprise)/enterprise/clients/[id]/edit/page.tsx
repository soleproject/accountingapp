import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, enterpriseClients, organizations } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { updateEnterpriseClientAction } from '../../../_actions/clients';
import { DeleteUserSection } from '../../../_components/DeleteUserSection';

export const dynamic = 'force-dynamic';

export default async function EditEnterpriseClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const enterprises = await listAccessibleEnterprises();
  if (enterprises.length === 0) notFound();
  const accessibleIds = enterprises.map((e) => e.id);

  const [link] = await db
    .select({ id: enterpriseClients.id })
    .from(enterpriseClients)
    .where(
      and(
        eq(enterpriseClients.clientUserId, id),
        inArray(enterpriseClients.enterpriseId, accessibleIds),
      ),
    )
    .limit(1);
  if (!link) notFound();

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!user) notFound();

  const ownedOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.ownerUserId, user.id));
  const confirmName = (user.fullName?.trim() || user.email).trim();

  return (
    <AdminPage
      title={`Edit ${user.fullName ?? user.email}`}
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Clients', href: '/enterprise/clients' },
        { label: user.fullName ?? user.email, href: `/enterprise/clients/${user.id}` },
        { label: 'Edit' },
      ]}
    >
      <Panel>
        <form action={updateEnterpriseClientAction} className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={user.id} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Full name <span className="text-red-500">*</span></span>
              <input
                type="text"
                name="fullName"
                required
                defaultValue={user.fullName ?? ''}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Email <span className="text-red-500">*</span></span>
              <input
                type="email"
                name="email"
                required
                defaultValue={user.email}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" name="isActive" defaultChecked={user.isActive} />
              <span>Active</span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Link
              href={`/enterprise/clients/${user.id}`}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Save changes
            </button>
          </div>
        </form>
      </Panel>

      <DeleteUserSection userId={user.id} userName={confirmName} ownedCount={ownedOrgs.length} />
    </AdminPage>
  );
}
