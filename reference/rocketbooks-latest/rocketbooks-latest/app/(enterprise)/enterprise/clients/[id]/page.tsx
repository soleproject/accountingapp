import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  organizationSupportUsers,
  userPermissionSets,
  permissionSets,
  adminAuditLog,
  aiAuditActions,
} from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { MonthlyTimeline } from '@/components/timeline/MonthlyTimeline';
import { getOrgMonthlyTimelineHistory } from '@/lib/monthly-timeline';
import { getDemoClientDetail } from '@/lib/enterprise/demo';
import { NeedsAttentionQueue } from '../../_components/NeedsAttentionQueue';
import { getCurrentEnterprise, listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { openClientBooksAction } from '../../_actions/openBooks';
import {
  deactivateEnterpriseClientAction,
  reactivateEnterpriseClientAction,
  setEnterpriseClientPermissionSetAction,
  setEnterpriseClientAccountingTierAction,
} from '../../_actions/clients';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';

export const dynamic = 'force-dynamic';

type TabId = 'overview' | 'monthly-close' | 'companies' | 'activity' | 'permissions' | 'settings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'monthly-close', label: 'Monthly Close' },
  { id: 'companies', label: 'Companies' },
  { id: 'activity', label: 'Activity Log' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'settings', label: 'Settings' },
];

function initials(name: string | null | undefined, email: string): string {
  const source = (name?.trim() || email).trim();
  const parts = source.split(/[\s@]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: TabId; view?: string }>;
}

export default async function EnterpriseClientDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { tab: tabParam, view: viewParam } = await searchParams;
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? 'overview') as TabId;

  const current = await getCurrentEnterprise();
  if (!current) notFound();

  // Demo enterprise clients (demo-user-N) aren't real DB users — render a
  // synthetic detail page with monthly bookkeeping history instead of 404ing.
  if (/^demo-user-\d+$/.test(id)) {
    const demo = getDemoClientDetail(id);
    if (!demo) notFound();
    const view: 'history' | 'needs' | 'comms' =
      viewParam === 'needs' || viewParam === 'comms' ? viewParam : 'history';
    const base = `/enterprise/clients/${id}`;
    const pillClass = (active: boolean) =>
      `rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
          : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`;
    return (
      <AdminPage
        title="User Details"
        crumbs={[
          { label: 'Enterprise', href: '/enterprise/dashboard' },
          { label: 'Clients', href: '/enterprise/clients' },
          { label: demo.ownerName },
        ]}
      >
        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{demo.orgName}</h2>
            <Badge tone="zinc">Demo</Badge>
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {demo.ownerName} · {demo.ownerEmail}
          </p>
        </Panel>

        <div className="flex flex-wrap gap-2">
          <Link href={base} className={pillClass(view === 'history')}>Monthly bookkeeping</Link>
          <Link href={`${base}?view=needs`} className={pillClass(view === 'needs')}>Needs attention</Link>
          <Link href={`${base}?view=comms`} className={pillClass(view === 'comms')}>Communications</Link>
        </div>

        {view === 'history' && (
          <Panel title="Monthly bookkeeping history">
            {demo.history.length > 0 ? (
              <div className="flex flex-col gap-4">
                {demo.history.map((tl) => (
                  <MonthlyTimeline
                    key={`${tl.period.year}-${tl.period.month}`}
                    steps={tl.steps}
                    periodLabel={tl.period.label}
                    defaultOrientation="horizontal"
                    hoverHighlight
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                No transaction data yet for this client.
              </div>
            )}
          </Panel>
        )}

        {view === 'needs' && (
          <NeedsAttentionQueue clients={[demo.health]} outreach={demo.outreach} demo />
        )}

        {view === 'comms' && (
          <Panel title="Communications">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Outreach sent to this client and their replies, newest first.
            </p>
            {demo.comms.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-400">No communications yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
                {demo.comms.map((c, i) => (
                  <li key={i} className="flex gap-3 py-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                      →
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{demo.orgName}</span>
                        <span className="shrink-0 text-xs text-zinc-400">{c.at ? c.at.toLocaleDateString() : '—'}</span>
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        Sent · {c.issueType.replace(/_/g, ' ')}
                        {c.channel ? ` · ${c.channel}` : ''}
                        {c.status === 'awaiting_response' ? ' · awaiting reply' : c.status === 'drafted' ? ' · draft' : ''}
                      </div>
                      <p className="mt-1 line-clamp-3 text-sm text-zinc-600 dark:text-zinc-300">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </AdminPage>
    );
  }

  const enterprises = await listAccessibleEnterprises();

  // 404 unless this user is actually a client of an enterprise the
  // signed-in user can see. The cross-check guards page access; the
  // server actions re-check before mutating.
  const accessibleIds = enterprises.map((e) => e.id);
  const [link] = await db
    .select({
      id: enterpriseClients.id,
      status: enterpriseClients.status,
      enterpriseId: enterpriseClients.enterpriseId,
    })
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
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!user) notFound();

  const [enterpriseRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, link.enterpriseId))
    .limit(1);

  const [
    ownedOrgs,
    supportAccess,
    permSet,
    allPermSets,
    activity,
    [aiUsage],
    [activityCountAgg],
  ] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        planType: organizations.planType,
        accountingTier: organizations.accountingTier,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(eq(organizations.ownerUserId, id)),
    db
      .select({
        id: organizationSupportUsers.id,
        status: organizationSupportUsers.status,
        organizationId: organizations.id,
        organizationName: organizations.name,
      })
      .from(organizationSupportUsers)
      .leftJoin(organizations, eq(organizations.id, organizationSupportUsers.organizationId))
      .where(eq(organizationSupportUsers.supportUserId, id)),
    db
      .select({ id: permissionSets.id, name: permissionSets.name })
      .from(userPermissionSets)
      .innerJoin(permissionSets, eq(permissionSets.id, userPermissionSets.permissionSetId))
      .where(eq(userPermissionSets.userId, id))
      .limit(1),
    db.select({ id: permissionSets.id, name: permissionSets.name }).from(permissionSets).orderBy(permissionSets.name),
    db
      .select({
        id: adminAuditLog.id,
        action: adminAuditLog.action,
        targetType: adminAuditLog.targetType,
        timestamp: adminAuditLog.timestamp,
      })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, id))
      .orderBy(desc(adminAuditLog.timestamp))
      .limit(50),
    db.select({ n: sql<number>`count(*)::int` }).from(aiAuditActions).where(eq(aiAuditActions.userId, id)),
    db.select({ n: sql<number>`count(*)::int` }).from(adminAuditLog).where(eq(adminAuditLog.targetId, id)),
  ]);

  // Connected Enterprises in this view = only enterprises the *signed-in*
  // user can also see. We don't leak other relationships the client has.
  const otherStaffMemberships = await db
    .select({
      id: enterpriseStaff.id,
      role: enterpriseStaff.role,
      enterpriseId: organizations.id,
      enterpriseName: organizations.name,
    })
    .from(enterpriseStaff)
    .leftJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
    .where(
      and(
        eq(enterpriseStaff.staffUserId, id),
        inArray(enterpriseStaff.enterpriseId, accessibleIds),
      ),
    );

  const currentPermSet = permSet[0] ?? null;
  // The client's plan lives on their owned books org (planType='pro'). NULL =
  // grandfathered flat $89. Drives the Plan selector below.
  const clientOrg = ownedOrgs.find((o) => o.planType === 'pro') ?? ownedOrgs[0] ?? null;
  const currentTier = clientOrg?.accountingTier ?? '';
  const totalLogins = user.lastLoginAt ? 1 : 0;
  const aiUsageCount = aiUsage?.n ?? 0;
  const organizationsCount = ownedOrgs.length;
  const activityCount = activityCountAgg?.n ?? 0;

  const tabHref = (t: TabId) => `/enterprise/clients/${id}?tab=${t}`;

  const assignablePermSets = allPermSets.filter(
    (p) => !p.name.toLowerCase().includes('super admin') && !p.name.toLowerCase().includes('superadmin'),
  );

  const isSelfSuper = user.role === 'super_admin' || user.role === 'superadmin';

  // Full monthly bookkeeping history for this client's books org — one timeline
  // per month with transaction data. Computed only when its tab is open;
  // requests/comms route to the firm comms hub.
  const monthlyHistory =
    tab === 'monthly-close' && clientOrg
      ? await getOrgMonthlyTimelineHistory(clientOrg.id, {
          requestsHref: '/enterprise/communications',
          communicationsHref: '/enterprise/communications',
        })
      : null;

  return (
    <AdminPage
      title="User Details"
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Clients', href: '/enterprise/clients' },
        { label: user.fullName ?? user.email },
      ]}
    >
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xl font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
              {initials(user.fullName, user.email)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">{user.fullName ?? user.email}</h2>
                <Badge tone={user.isActive ? 'green' : 'red'}>{user.isActive ? 'Active' : 'Inactive'}</Badge>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Email:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{user.email}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Role:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{user.role}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Enterprise:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{enterpriseRow?.name ?? current.name}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Organization:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{ownedOrgs[0]?.name ?? 'N/A'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">Created:</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">{fmtDate(user.createdAt)}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isSelfSuper ? (
              <button
                type="button"
                disabled
                title="Can't impersonate a super admin"
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm opacity-50"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                Impersonate
              </button>
            ) : (
              <form action={openClientBooksAction} className="inline">
                <input type="hidden" name="targetUserId" value={user.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                  title={`Open ${user.fullName ?? user.email}'s books — you'll be working in their company until you close them.`}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  Open books
                </button>
              </form>
            )}

            <Link
              href={`/enterprise/clients/${user.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </Link>

            <form action={user.isActive ? deactivateEnterpriseClientAction : reactivateEnterpriseClientAction} className="inline">
              <input type="hidden" name="userId" value={user.id} />
              <button
                type="submit"
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium ${
                  user.isActive
                    ? 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40'
                    : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
                }`}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {user.isActive ? 'Disable' : 'Enable'}
              </button>
            </form>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="Total Logins" value={totalLogins.toLocaleString()} accent="blue" icon={
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
          </svg>
        } />
        <KpiTile label="Last Login" value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'} accent="zinc" icon={
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
        } />
        <KpiTile label="AI Usage" value={aiUsageCount.toLocaleString()} accent="violet" icon={
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        } />
        <KpiTile label="Organizations" value={organizationsCount.toLocaleString()} accent="cyan" icon={
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="2" width="16" height="20" rx="1" />
            <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
          </svg>
        } />
        <KpiTile label="Activity Count" value={activityCount.toLocaleString()} accent="rose" icon={
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        } />
      </div>

      <Panel title="Connected Enterprises">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <EnterpriseCard
            name={enterpriseRow?.name ?? current.name}
            roleLabel="Paying User"
            tone="green"
          />
          {otherStaffMemberships.map((m) => (
            <EnterpriseCard
              key={m.id}
              name={m.enterpriseName ?? 'Unknown'}
              roleLabel={m.role === 'owner' ? 'Enterprise Owner' : 'Enterprise Staff'}
              tone="blue"
            />
          ))}
        </div>
      </Panel>

      <Panel title="Plan">
        <form action={setEnterpriseClientAccountingTierAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="userId" value={user.id} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-xs uppercase text-zinc-500">Accounting Plan</span>
            <select
              name="accountingTier"
              defaultValue={currentTier}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Legacy ($89/mo flat)</option>
              {ACCOUNTING_TIER_KEYS.map((key) => {
                const tier = ACCOUNTING_TIERS[key];
                return (
                  <option key={key} value={key}>{tier.label} — {tier.shortLabel}</option>
                );
              })}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Save plan
          </button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          Sets the client&apos;s plan, the features they get, and (Phase 5) their billing. Updates their permission set automatically.
        </p>
      </Panel>

      <Panel title="User Type (advanced)">
        <form action={setEnterpriseClientPermissionSetAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="userId" value={user.id} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-xs uppercase text-zinc-500">Permission Set</span>
            <select
              name="permissionSetId"
              defaultValue={currentPermSet?.id ?? ''}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— None —</option>
              {assignablePermSets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Save
          </button>
        </form>
      </Panel>

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
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <section>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">User Information</h3>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">User ID: </dt>
                    <dd className="inline break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{user.id}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Account Created: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">{fmtDate(user.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">Status: </dt>
                    <dd className="inline text-zinc-600 dark:text-zinc-400">{user.isActive ? 'Active' : 'Inactive'}</dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">User Type</h3>
                {currentPermSet ? (
                  <span className="text-sm">{currentPermSet.name}</span>
                ) : (
                  <span className="text-sm text-zinc-500">None assigned</span>
                )}
              </section>

              <section>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Quick Links</h3>
                <ul className="space-y-2 text-sm">
                  <li>
                    <Link href={`/enterprise/clients/${user.id}/edit`} className="text-blue-700 hover:underline dark:text-blue-300">
                      Edit user →
                    </Link>
                  </li>
                </ul>
              </section>
            </div>
          )}

          {tab === 'monthly-close' && (
            <section className="flex flex-col gap-4">
              {!clientOrg ? (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  This user has no books organization to close.
                </div>
              ) : monthlyHistory && monthlyHistory.length > 0 ? (
                monthlyHistory.map((tl) => (
                  <MonthlyTimeline
                    key={`${tl.period.year}-${tl.period.month}`}
                    steps={tl.steps}
                    periodLabel={tl.period.label}
                    defaultOrientation="horizontal"
                    hoverHighlight
                  />
                ))
              ) : (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  No transaction data yet for this client.
                </div>
              )}
            </section>
          )}

          {tab === 'companies' && (
            <div className="flex flex-col gap-3">
              {ownedOrgs.length === 0 ? (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  This user does not own any organizations.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                  {ownedOrgs.map((o) => (
                    <li key={o.id} className="flex items-center justify-between py-2">
                      <div className="font-medium">{o.name}</div>
                      <div className="flex items-center gap-2">
                        <Badge tone="zinc">{o.planType}</Badge>
                        <span className="text-xs text-zinc-500">
                          {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {supportAccess.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Support access</h4>
                  <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                    {supportAccess.map((s) => (
                      <li key={s.id} className="flex items-center justify-between py-2">
                        <div className="font-medium">{s.organizationName ?? 'Unknown organization'}</div>
                        <Badge tone={s.status === 'active' ? 'green' : 'zinc'}>{s.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {tab === 'activity' && (
            <section>
              {activity.length === 0 ? (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  No admin activity recorded for this user.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                  {activity.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-2">
                      <div>
                        <span className="font-medium">{a.action}</span>
                        <span className="ml-2 text-xs text-zinc-500">{a.targetType}</span>
                      </div>
                      <span className="text-xs text-zinc-500">
                        {a.timestamp ? new Date(a.timestamp).toLocaleString() : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === 'permissions' && (
            <section className="flex flex-col gap-4">
              <p className="text-sm text-zinc-500">
                This user&apos;s effective permissions come from their assigned permission set. Use the User Type dropdown above to change it.
              </p>
              {currentPermSet ? (
                <div className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                  <div className="font-medium">{currentPermSet.name}</div>
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                  No permission set assigned. Pick one from the User Type dropdown above.
                </div>
              )}
            </section>
          )}

          {tab === 'settings' && (
            <section className="flex flex-col gap-4">
              <p className="text-sm text-zinc-500">
                Editing the user&apos;s name, email, or active state lives on the Edit page.
              </p>
              <Link
                href={`/enterprise/clients/${user.id}/edit`}
                className="inline-flex w-fit items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
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

const ACCENT_FG = {
  blue: 'text-blue-600 dark:text-blue-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
  violet: 'text-violet-600 dark:text-violet-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  rose: 'text-rose-600 dark:text-rose-400',
} as const;

function KpiTile({ label, value, accent, icon }: { label: string; value: string; accent: keyof typeof ACCENT_FG; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className={ACCENT_FG[accent]}>{icon}</span>
      </div>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

const TONE_BADGE = {
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
} as const;

function EnterpriseCard({
  name,
  roleLabel,
  tone,
}: {
  name: string;
  roleLabel: string;
  tone: keyof typeof TONE_BADGE;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TONE_BADGE[tone]}`}>
          {roleLabel}
        </span>
      </div>
    </div>
  );
}
