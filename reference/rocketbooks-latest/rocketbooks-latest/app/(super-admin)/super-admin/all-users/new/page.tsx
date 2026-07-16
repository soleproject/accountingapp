import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { permissionSets, organizations, enterpriseStaff, enterpriseClients } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { CreateUserForm } from '../../_components/CreateUserForm';

export const dynamic = 'force-dynamic';

export default async function NewUserPage() {
  const [permSets, enterpriseRows, orgRows] = await Promise.all([
    db.select({ id: permissionSets.id, name: permissionSets.name }).from(permissionSets).orderBy(asc(permissionSets.name)),
    // Enterprises = orgs with planType='enterprise' OR present in enterprise_staff/enterprise_clients.
    db
      .selectDistinct({
        id: organizations.id,
        name: organizations.name,
        tier: organizations.enterpriseTier,
      })
      .from(organizations)
      .where(
        sql`${organizations.planType} = 'enterprise'
            or ${organizations.id} in (select enterprise_id from enterprise_staff)
            or ${organizations.id} in (select enterprise_id from enterprise_clients)`,
      )
      .orderBy(asc(organizations.name)),
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name)),
  ]);

  // Suppress unused so future tweaks can ditch the unused imports cleanly.
  void enterpriseStaff;
  void enterpriseClients;
  void eq;

  return (
    <AdminPage
      title="Create User"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'All Users', href: '/super-admin/all-users' },
        { label: 'Create User' },
      ]}
    >
      <Panel>
        <CreateUserForm
          permissionSets={permSets}
          enterprises={enterpriseRows}
          organizations={orgRows}
        />
      </Panel>
    </AdminPage>
  );
}
