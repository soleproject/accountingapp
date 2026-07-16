import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql, eq, desc, gte, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  users,
  enterpriseStaff,
  enterpriseClients,
  adminAuditLog,
} from '@/db/schema/schema';
import { AdminPage, Badge, Panel, MetricTile } from '@/components/admin/AdminPage';
import { ENTERPRISE_TIERS, isEnterpriseTierKey } from '@/lib/enterprise/tiers';
import {
  addEnterpriseStaffAction,
  removeEnterpriseStaffAction,
  suspendEnterpriseAction,
  reactivateEnterpriseAction,
  deleteEnterpriseAction,
} from '../../_actions/admin';

export const dynamic = 'force-dynamic';

type TabId = 'overview' | 'users' | 'organizations' | 'admins' | 'activity' | 'billing' | 'settings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'organizations', label: 'Organizations' },
  { id: 'admins', label: 'Admins' },
  { id: 'activity', label: 'Activity' },
  { id: 'billing', label: 'Billing' },
  { id: 'settings', label: 'Settings' },
];

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: TabId }>;
}

export default async function EnterpriseDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? 'overview') as TabId;

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      domain: organizations.domain,
      planType: organizations.planType,
      tier: organizations.enterpriseTier,
      privateLabelEnabled: organizations.privateLabelEnabled,
      createdAt: organizations.createdAt,
      logoUrl: organizations.logoUrl,
      ownerId: organizations.ownerUserId,
      ownerEmail: users.email,
      ownerName: users.fullName,
    })
    .from(organizations)
    .leftJoin(users, eq(users.id, organizations.ownerUserId))
    .where(eq(organizations.id, id))
    .limit(1);

  if (!org) notFound();

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Aggregate stats for the KPI tiles.
  const [
    [staffCount],
    [clientCount],
    [newClientsMonth],
    [orgsOwnedByClients],
    [lastActivity],
  ] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(enterpriseStaff).where(eq(enterpriseStaff.enterpriseId, id)),
    db.select({ n: sql<number>`count(*)::int` }).from(enterpriseClients).where(eq(enterpriseClients.enterpriseId, id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(enterpriseClients)
      .where(and(eq(enterpriseClients.enterpriseId, id), gte(enterpriseClients.createdAt, monthAgo))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizations)
      .where(sql`${organizations.ownerUserId} in (select client_user_id from enterprise_clients where enterprise_id = ${id})`),
    db
      .select({ ts: adminAuditLog.timestamp })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, id))
      .orderBy(desc(adminAuditLog.timestamp))
      .limit(1),
  ]);

  const totalUsers = (staffCount?.n ?? 0) + (clientCount?.n ?? 0);
  const totalOrganizations = orgsOwnedByClients?.n ?? 0;
  const totalClients = clientCount?.n ?? 0;
  const newClients = newClientsMonth?.n ?? 0;

  const isSuspended = org.planType === 'suspended';
  const tier = isEnterpriseTierKey(org.tier) ? ENTERPRISE_TIERS[org.tier] : null;
  const clientsUsed = clientCount?.n ?? 0;
  const overCap = tier !== null && clientsUsed > tier.includedCompaniesCap;

  // ----- Tab data -----
  const usersInTab =
    tab === 'users' || tab === 'admins'
      ? await db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            role: users.role,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
            kind: sql<string>`'staff'`.as('kind'),
            staffId: enterpriseStaff.id,
            staffRole: enterpriseStaff.role,
          })
          .from(enterpriseStaff)
          .innerJoin(users, eq(users.id, enterpriseStaff.staffUserId))
          .where(eq(enterpriseStaff.enterpriseId, id))
      : [];

  const clientsInTab =
    tab === 'users' || tab === 'organizations'
      ? await db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
            clientId: enterpriseClients.id,
            status: enterpriseClients.status,
          })
          .from(enterpriseClients)
          .innerJoin(users, eq(users.id, enterpriseClients.clientUserId))
          .where(eq(enterpriseClients.enterpriseId, id))
      : [];

  const orgsOwnedRows =
    tab === 'organizations' && clientsInTab.length > 0
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            planType: organizations.planType,
            createdAt: organizations.createdAt,
            ownerEmail: users.email,
            ownerName: users.fullName,
          })
          .from(organizations)
          .leftJoin(users, eq(users.id, organizations.ownerUserId))
          .where(inArray(organizations.ownerUserId, clientsInTab.map((c) => c.id)))
          .orderBy(desc(organizations.createdAt))
      : [];

  const activityRows =
    tab === 'activity'
      ? await db
          .select({
            id: adminAuditLog.id,
            action: adminAuditLog.action,
            targetType: adminAuditLog.targetType,
            timestamp: adminAuditLog.timestamp,
            adminEmail: users.email,
          })
          .from(adminAuditLog)
          .leftJoin(users, eq(users.id, adminAuditLog.adminUserId))
          .where(eq(adminAuditLog.targetId, id))
          .orderBy(desc(adminAuditLog.timestamp))
          .limit(50)
      : [];

  const tabHref = (t: TabId) => `/super-admin/enterprises/${id}?tab=${t}`;

  return (
    <AdminPage
      title="Enterprise Details"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Enterprises', href: '/super-admin/enterprises' },
      ]}
    >
      {/* Top card */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {org.logoUrl && (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={org.logoUrl} alt={`${org.name} logo`} className="h-full w-full object-contain" />
              </div>
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">{org.name}</h2>
                <Badge tone={isSuspended ? 'red' : 'green'}>{isSuspended ? 'suspended' : 'active'}</Badge>
                <Badge tone="blue">{org.planType}</Badge>
                {tier && <Badge tone="amber">{tier.shortLabel}</Badge>}
                {org.privateLabelEnabled && <Badge tone="zinc">Private label</Badge>}
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Domain:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{org.domain ?? '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Owner:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">
                    {org.ownerName ?? 'Unknown'} {org.ownerEmail ? <span>({org.ownerEmail})</span> : null}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Created:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">
                    {org.createdAt ? new Date(org.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled
              title="Impersonation isn't wired up yet"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 opacity-60 dark:border-blue-800 dark:text-blue-300"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Impersonate Owner
            </button>

            <form action={isSuspended ? reactivateEnterpriseAction : suspendEnterpriseAction} className="inline">
              <input type="hidden" name="id" value={org.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {isSuspended ? 'Reactivate' : 'Suspend'}
              </button>
            </form>

            <form action={deleteEnterpriseAction} className="inline">
              <input type="hidden" name="id" value={org.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                </svg>
                Delete
              </button>
            </form>

            <Link
              href={`/super-admin/enterprises/${org.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </Link>
          </div>
        </div>
      </Panel>

      {/* Primary KPI tiles */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <MetricTile
          label="Total Users"
          value={totalUsers}
          iconColor="text-violet-600 dark:text-violet-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
            </svg>
          }
        />
        <MetricTile
          label="Organizations"
          value={totalOrganizations}
          iconColor="text-blue-600 dark:text-blue-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="1" />
              <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
            </svg>
          }
        />
        <MetricTile
          label="Total Clients"
          value={totalClients}
          iconColor="text-emerald-600 dark:text-emerald-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
        />
        <MetricTile
          label="Monthly Revenue"
          value="$0"
          iconColor="text-blue-600 dark:text-blue-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />
        <MetricTile
          label="Outstanding Payments"
          value="$0"
          iconColor="text-amber-600 dark:text-amber-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }
        />
        <MetricTile
          label="Active Subscriptions"
          value={isSuspended ? 0 : 1}
          iconColor="text-emerald-600 dark:text-emerald-400"
          icon={
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          }
        />
      </div>

      {/* Tier / revenue share */}
      {tier && (
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{tier.label}</h3>
                <Badge tone="amber">{tier.shortLabel}</Badge>
                {overCap && <Badge tone="amber">Over included cap</Badge>}
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                ${(tier.priceCents / 100).toLocaleString()}/{tier.interval} · private label enabled
              </p>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className={`text-2xl font-semibold tabular-nums ${overCap ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-900 dark:text-zinc-100'}`}>
                {clientsUsed} <span className="text-base text-zinc-500">/ {tier.includedCompaniesCap}</span>
              </span>
              <span className="text-xs text-zinc-500">companies included</span>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Client price</dt>
              <dd className="mt-1 text-zinc-900 dark:text-zinc-100">
                ${(tier.clientPriceCents / 100).toLocaleString()}/mo
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Partner share (within cap)</dt>
              <dd className="mt-1 text-zinc-900 dark:text-zinc-100">
                ${(tier.partnerShareCentsPreCap / 100).toLocaleString()}/client/mo
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Partner share (post-cap split)</dt>
              <dd className="mt-1 text-zinc-900 dark:text-zinc-100">
                ${(tier.partnerShareCentsPostCap / 100).toLocaleString()}/client/mo
              </dd>
            </div>
          </dl>
        </Panel>
      )}

      {/* Secondary stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="New Users This Month" value={0} delta={{ value: '15%', positive: true }} />
        <MetricTile label="New Clients This Month" value={newClients} delta={{ value: '8%', positive: true }} />
        <MetricTile label="Failed Logins" value={0} delta={{ value: '3%', positive: false }} />
        <MetricTile label="AI Usage (Requests)" value={0} delta={{ value: '28%', positive: true }} />
      </div>

      {/* Tabs */}
      <Panel className="overflow-hidden p-0">
        <div className="flex overflow-x-auto border-b border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <Link
                key={t.id}
                href={tabHref(t.id)}
                className={`whitespace-nowrap border-b-2 px-5 py-3 text-sm transition-colors ${
                  active
                    ? 'border-blue-600 font-semibold text-blue-700 dark:border-blue-400 dark:text-blue-300'
                    : 'border-transparent font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        <div className="p-6">
          {tab === 'overview' && (
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
              <section>
                <h3 className="mb-3 text-lg font-semibold">Overview</h3>
                <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Enterprise Information</h4>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Enterprise ID: </dt>
                    <dd className="inline break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{org.id}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Registration Date: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">
                      {org.createdAt ? new Date(org.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Last Activity: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">{fmtTimeAgo(lastActivity?.ts)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Timezone: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">America/New_York</dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="mb-3 text-lg font-semibold">&nbsp;</h3>
                <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Subscription Details</h4>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Plan: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">{org.planType}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Billing Cycle: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">Monthly</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Next Billing Date: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">—</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Auto-renewal: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">Enabled</dd>
                  </div>
                </dl>
              </section>
            </div>
          )}

          {tab === 'users' && (
            <div className="flex flex-col gap-6">
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Staff ({usersInTab.length})</h3>
                </div>
                <form action={addEnterpriseStaffAction} className="mb-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="enterpriseId" value={org.id} />
                  <label className="flex flex-1 flex-col gap-1 text-sm">
                    <span className="text-xs text-zinc-500">Staff email</span>
                    <input type="email" name="staffEmail" required placeholder="staff@enterprise.com" className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-zinc-500">Role</span>
                    <select name="role" className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                      <option value="staff">staff</option>
                      <option value="admin">admin</option>
                      <option value="owner">owner</option>
                    </select>
                  </label>
                  <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                    Add staff
                  </button>
                </form>
                {usersInTab.length === 0 ? (
                  <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                    No staff yet.
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                    {usersInTab.map((s) => (
                      <li key={s.staffId} className="flex items-center justify-between py-2">
                        <div>
                          <Link href={`/super-admin/all-users/${s.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                            {s.fullName ?? s.email}
                          </Link>
                          <span className="ml-2 text-xs text-zinc-500">{s.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone="blue">{s.staffRole}</Badge>
                          <form action={removeEnterpriseStaffAction} className="inline">
                            <input type="hidden" name="id" value={s.staffId} />
                            <input type="hidden" name="enterpriseId" value={org.id} />
                            <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-300">
                              Remove
                            </button>
                          </form>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-3 text-lg font-semibold">Clients ({clientsInTab.length})</h3>
                {clientsInTab.length === 0 ? (
                  <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                    No clients yet.
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                    {clientsInTab.map((c) => (
                      <li key={c.clientId} className="flex items-center justify-between py-2">
                        <div>
                          <Link href={`/super-admin/all-users/${c.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                            {c.fullName ?? c.email}
                          </Link>
                          <span className="ml-2 text-xs text-zinc-500">{c.email}</span>
                        </div>
                        <Badge tone={c.status === 'active' ? 'green' : 'zinc'}>{c.status}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {tab === 'organizations' && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Organizations ({orgsOwnedRows.length})</h3>
              <p className="mb-3 text-sm text-zinc-500">Companies (books) owned by clients of this enterprise.</p>
              {orgsOwnedRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  No client organizations yet.
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                      <tr>
                        <th className="px-4 py-2.5">Name</th>
                        <th className="px-4 py-2.5">Owner</th>
                        <th className="px-4 py-2.5">Plan</th>
                        <th className="px-4 py-2.5">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgsOwnedRows.map((o) => (
                        <tr key={o.id} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="px-4 py-2 font-medium">{o.name}</td>
                          <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{o.ownerName ?? o.ownerEmail ?? '—'}</td>
                          <td className="px-4 py-2"><Badge tone="zinc">{o.planType}</Badge></td>
                          <td className="px-4 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">
                            {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'admins' && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Admins</h3>
              <p className="mb-3 text-sm text-zinc-500">Enterprise staff with admin or owner role.</p>
              {(() => {
                const admins = usersInTab.filter((s) => s.staffRole === 'admin' || s.staffRole === 'owner');
                if (admins.length === 0) {
                  return (
                    <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                      No admins or owners assigned.
                    </div>
                  );
                }
                return (
                  <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                    {admins.map((u) => (
                      <li key={u.staffId} className="flex items-center justify-between py-2">
                        <div>
                          <Link href={`/super-admin/all-users/${u.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                            {u.fullName ?? u.email}
                          </Link>
                          <span className="ml-2 text-xs text-zinc-500">{u.email}</span>
                        </div>
                        <Badge tone="blue">{u.staffRole}</Badge>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </section>
          )}

          {tab === 'activity' && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Activity</h3>
              {activityRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  No activity yet.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                  {activityRows.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-2">
                      <div>
                        <span className="font-medium">{a.action}</span>
                        <span className="ml-2 text-xs text-zinc-500">by {a.adminEmail ?? 'system'} · {a.targetType}</span>
                      </div>
                      <span className="text-xs text-zinc-500">{a.timestamp ? new Date(a.timestamp).toLocaleString() : '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === 'billing' && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Billing</h3>
              <p className="text-sm text-zinc-500">No billing provider connected yet. When you wire one up, invoices, plan changes, and payment history will surface here.</p>
            </section>
          )}

          {tab === 'settings' && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Settings</h3>
              <p className="mb-3 text-sm text-zinc-500">Editing fields (name, domain, logo, plan, contact info) lives on the Edit page.</p>
              <Link
                href={`/super-admin/enterprises/${org.id}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Open Edit page →
              </Link>
            </section>
          )}
        </div>
      </Panel>
    </AdminPage>
  );
}
