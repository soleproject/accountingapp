import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { and, asc, ne, sql } from 'drizzle-orm';
import {
  users,
  permissionSets,
  userPermissionSets,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  organizationSupportUsers,
} from '@/db/schema/schema';
import { isEnterpriseTierKey } from '@/lib/enterprise/tiers';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { updateUserAction } from '../../../_actions/admin';
import { PasswordField } from './_components/PasswordField';
import { SendResetEmailButton } from './_components/SendResetEmailButton';
import { GenerateTempPasswordButton } from './_components/GenerateTempPasswordButton';
import { UserRolesEditor } from './_components/UserRolesEditor';

export const dynamic = 'force-dynamic';

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!user) notFound();

  // Permission set ("User Type") is a real editable assignment in
  // userPermissionSets. We also load the user's current enterprise memberships
  // so the Roles & Access editor below can render with the right boxes checked.
  const [
    allPermSets,
    currentPermSet,
    ownedEnterprises,
    ownerStaff,
    plainStaff,
    clients,
    supports,
    enterpriseRows,
    orgRows,
  ] = await Promise.all([
    db
      .select({ id: permissionSets.id, name: permissionSets.name })
      .from(permissionSets)
      .orderBy(asc(permissionSets.name)),
    db
      .select({ id: userPermissionSets.permissionSetId })
      .from(userPermissionSets)
      .where(eq(userPermissionSets.userId, id))
      .limit(1),
    db
      .select({ id: organizations.id, name: organizations.name, tier: organizations.enterpriseTier })
      .from(organizations)
      .where(and(eq(organizations.ownerUserId, id), eq(organizations.planType, 'enterprise'))),
    db
      .select({ enterpriseId: enterpriseStaff.enterpriseId, name: organizations.name, tier: organizations.enterpriseTier })
      .from(enterpriseStaff)
      .leftJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
      .where(and(eq(enterpriseStaff.staffUserId, id), eq(enterpriseStaff.role, 'owner'))),
    db
      .select({ id: enterpriseStaff.id })
      .from(enterpriseStaff)
      .where(and(eq(enterpriseStaff.staffUserId, id), ne(enterpriseStaff.role, 'owner'))),
    db.select({ id: enterpriseClients.id }).from(enterpriseClients).where(eq(enterpriseClients.clientUserId, id)),
    db.select({ id: organizationSupportUsers.id }).from(organizationSupportUsers).where(eq(organizationSupportUsers.supportUserId, id)),
    // Enterprises = orgs with planType='enterprise' OR present in enterprise_staff/enterprise_clients.
    db
      .selectDistinct({ id: organizations.id, name: organizations.name, tier: organizations.enterpriseTier })
      .from(organizations)
      .where(
        sql`${organizations.planType} = 'enterprise'
            or ${organizations.id} in (select enterprise_id from enterprise_staff)
            or ${organizations.id} in (select enterprise_id from enterprise_clients)`,
      )
      .orderBy(asc(organizations.name)),
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name)),
  ]);
  const currentPermSetId = currentPermSet[0]?.id ?? '';

  // The enterprise this user heads (owns the org, or has an owner staff row).
  const headed = ownedEnterprises[0] ?? ownerStaff[0] ?? null;
  const isCurrentlyOwner = headed != null;
  const headedTier = (headed?.tier ?? null) as string | null;
  const currentTier = isCurrentlyOwner
    ? (isEnterpriseTierKey(headedTier) ? headedTier : 'regular')
    : null;

  const rolesInitial = {
    baseUser: user.role === 'base_user',
    enterpriseOwner: isCurrentlyOwner,
    enterpriseStaff: plainStaff.length > 0,
    payingUser: clients.length > 0,
    supportUser: supports.length > 0,
  };

  return (
    <AdminPage
      title={`Edit ${user.fullName ?? user.email}`}
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'All Users', href: '/super-admin/all-users' },
        { label: user.fullName ?? user.email, href: `/super-admin/all-users/${user.id}` },
        { label: 'Edit' },
      ]}
    >
      <Panel>
        <form action={updateUserAction} className="flex flex-col gap-4">
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
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Role <span className="text-red-500">*</span></span>
              <select
                name="role"
                defaultValue={user.role}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="super_admin">super_admin</option>
                <option value="admin">admin</option>
                <option value="enterprise_owner">enterprise_owner</option>
                <option value="enterprise_staff">enterprise_staff</option>
                <option value="paying_user">paying_user</option>
                <option value="support_user">support_user</option>
                <option value="investor">investor</option>
                <option value="free_account">free_account</option>
                <option value="base_user">base_user</option>
                <option value="user">user</option>
              </select>
              <span className="text-xs text-zinc-500">
                The user's primary role label. Drives the workspace dropdown. To actually grant enterprise access (memberships, owner tier), use Roles &amp; Access below — changing this dropdown alone does not.
              </span>
            </label>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" name="isActive" defaultChecked={user.isActive} />
              <span>Active</span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">User Type (Permission Set)</span>
              <select
                name="permissionSetId"
                defaultValue={currentPermSetId}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">— None —</option>
                {allPermSets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <span className="text-xs text-zinc-500">
                Optional — bundles a set of permissions onto the user. Same field as the User Type panel on the user&apos;s detail page.
              </span>
            </label>
            <PasswordField />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Link
              href={`/super-admin/all-users/${user.id}`}
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

      {/* Roles & Access — the editable counterpart to the Create wizard's
          "User Roles" block. Changing the Role dropdown above only relabels
          users.role; THIS provisions the enterprise memberships that actually
          grant access (e.g. promoting a paying user to a Regular Enterprise
          Owner), so the user doesn't end up role='enterprise_owner' but locked
          out of the enterprise area. */}
      <Panel title="Roles & Access">
        <UserRolesEditor
          userId={user.id}
          initial={rolesInitial}
          isCurrentlyOwner={isCurrentlyOwner}
          currentTier={currentTier}
          headedEnterpriseName={headed?.name ?? null}
          enterprises={enterpriseRows}
          organizations={orgRows}
        />
      </Panel>

      <Panel>
        <SendResetEmailButton userId={user.id} email={user.email} />
      </Panel>

      <Panel>
        <GenerateTempPasswordButton userId={user.id} email={user.email} />
      </Panel>
    </AdminPage>
  );
}
