import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  platformMaintenanceState,
  organizations,
  users,
  permissionSets,
} from '@/db/schema/schema';
import { AdminPage, Panel, Badge } from '@/components/admin/AdminPage';
import { setMaintenanceModeAction } from '../_actions/admin';

export const dynamic = 'force-dynamic';

export default async function SuperAdminSettingsPage() {
  const [maint, [orgCount], [userCount], [setCount]] = await Promise.all([
    db.select().from(platformMaintenanceState).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(organizations),
    db.select({ n: sql<number>`count(*)::int` }).from(users),
    db.select({ n: sql<number>`count(*)::int` }).from(permissionSets),
  ]);

  const maintenanceOn = maint[0]?.maintenanceMode === true;
  const maintenanceUpdated = maint[0]?.updatedAt ?? null;

  return (
    <AdminPage
      title="Super Admin Settings"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Settings' }]}
    >
      <Panel title="Maintenance Mode" className="border-amber-200 bg-amber-50/30 dark:border-amber-900/50 dark:bg-amber-950/10">
        <form action={setMaintenanceModeAction} className="flex items-center justify-between gap-4">
          <div>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={maintenanceOn}
                className="h-4 w-4"
              />
              <span className="font-medium">{maintenanceOn ? 'Maintenance mode ON' : 'Enable maintenance mode'}</span>
              <Badge tone={maintenanceOn ? 'amber' : 'zinc'}>{maintenanceOn ? 'on' : 'off'}</Badge>
            </label>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              When on, non-admin users see a maintenance page instead of the app. SuperAdmin retains access.
              {maintenanceUpdated && (
                <> · Last changed {new Date(maintenanceUpdated).toLocaleString()}</>
              )}
            </p>
          </div>
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
        </form>
      </Panel>

      <Panel title="Platform">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-zinc-500">Total organizations</dt>
            <dd className="text-2xl font-semibold tabular-nums">{orgCount?.n ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Total users</dt>
            <dd className="text-2xl font-semibold tabular-nums">{userCount?.n ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Permission sets</dt>
            <dd className="text-2xl font-semibold tabular-nums">{setCount?.n ?? 0}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Defaults for new organizations">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-zinc-500">Default Plan</dt>
            <dd className="mt-1 font-mono text-xs">pro</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Accounting Method</dt>
            <dd className="mt-1 font-mono text-xs">accrual</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Onboarding Mode</dt>
            <dd className="mt-1 font-mono text-xs">simple</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">Powered-By Footer</dt>
            <dd className="mt-1 font-mono text-xs">enabled</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          These come from <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-900">organizations</code> column defaults. Surfaced here for visibility; edit them by altering the schema defaults.
        </p>
      </Panel>
    </AdminPage>
  );
}
