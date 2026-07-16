import Link from 'next/link';
import { sql, desc, eq, ilike, or, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  organizationSupportUsers,
  userPermissionSets,
  permissionSets,
} from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { AllUsersTable } from '../_components/AllUsersTable';
import { EnterpriseFilterSelect } from '../_components/EnterpriseFilterSelect';
import { GroupedByEnterpriseUsers } from '../_components/GroupedByEnterpriseUsers';
import { AllUsersFilters } from '../_components/AllUsersFilters';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

type UserType = 'all' | 'superadmin' | 'user' | 'admin' | 'staff' | 'paying_user' | 'investor' | 'free_account';
type Membership = 'all' | 'enterprise' | 'non-enterprise';
type Ownership = 'all' | 'paying' | 'support' | 'none';
type View = 'list' | 'grouped';

interface SearchParams {
  q?: string;
  type?: UserType;
  membership?: Membership;
  ownership?: Ownership;
  enterpriseId?: string;
  view?: View;
  page?: string;
  created?: string;
  temp?: string;
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
      }`}
    >
      {children}
    </Link>
  );
}

function buildHref(base: SearchParams, override: Partial<SearchParams>): string {
  const merged: SearchParams = { ...base, ...override };
  const p = new URLSearchParams();
  if (merged.q) p.set('q', merged.q);
  if (merged.type && merged.type !== 'all') p.set('type', merged.type);
  if (merged.membership && merged.membership !== 'all') p.set('membership', merged.membership);
  if (merged.ownership && merged.ownership !== 'all') p.set('ownership', merged.ownership);
  if (merged.enterpriseId) p.set('enterpriseId', merged.enterpriseId);
  if (merged.view && merged.view !== 'list') p.set('view', merged.view);
  if (merged.page && merged.page !== '1') p.set('page', merged.page);
  const qs = p.toString();
  return qs ? `/super-admin/all-users?${qs}` : '/super-admin/all-users';
}

export default async function AllUsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const type: UserType = sp.type ?? 'all';
  const membership: Membership = sp.membership ?? 'all';
  const ownership: Ownership = sp.ownership ?? 'all';
  const enterpriseId = (sp.enterpriseId ?? '').trim();
  const view: View = sp.view === 'grouped' ? 'grouped' : 'list';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  // Sub-select sets for joins (single round-trip filtering).
  // Enterprise membership: users with any row in enterpriseStaff.
  // Company ownership: users in organizations.ownerUserId.
  // Support access: users in organizationSupportUsers.

  const conds = [] as ReturnType<typeof eq>[];

  if (q) {
    conds.push(or(ilike(users.email, `%${q}%`), ilike(users.fullName, `%${q}%`))!);
  }

  // Each User Type filter mirrors what the User Type column displays:
  //   - assigned permission set name takes precedence (one match by ps.name)
  //   - otherwise fall back to users.role mapped to the canonical label
  // The role branch only fires when the user has NO permission set assigned,
  // so a user whose set says "Free Account" never matches "Paying User"
  // even if their underlying users.role is 'client'.
  const filterByType = (psName: string, roles: string[]) =>
    or(
      sql`${users.id} in (
        select ups.user_id from user_permission_sets ups
        join permission_sets ps on ps.id = ups.permission_set_id
        where ps.name = ${psName}
      )`,
      and(
        sql`${users.id} not in (select user_id from user_permission_sets)`,
        inArray(users.role, roles),
      ),
    )!;

  if (type === 'superadmin') {
    conds.push(filterByType('Super Admin', ['super_admin', 'superadmin']));
  } else if (type === 'admin') {
    // No "Admin" permission set in the catalog — match by role only.
    conds.push(eq(users.role, 'admin'));
  } else if (type === 'staff') {
    // No "Staff" permission set — match by role only.
    conds.push(eq(users.role, 'staff'));
  } else if (type === 'paying_user') {
    conds.push(filterByType('Paying User', ['paying_user', 'client']));
  } else if (type === 'investor') {
    conds.push(filterByType('Investor', ['investor']));
  } else if (type === 'free_account') {
    conds.push(filterByType('Free Account', ['free_account', 'free']));
  } else if (type === 'user') {
    // Matches users displayed as "Base User": permission set = Base User,
    // or no permission set and role is the base/user fallback.
    conds.push(filterByType('Base User', ['user', 'base_user']));
  }

  if (membership === 'enterprise') {
    conds.push(sql`${users.id} in (select staff_user_id from enterprise_staff)`);
  } else if (membership === 'non-enterprise') {
    conds.push(sql`${users.id} not in (select staff_user_id from enterprise_staff)`);
  }

  if (ownership === 'paying') {
    conds.push(sql`${users.id} in (select owner_user_id from organizations)`);
  } else if (ownership === 'support') {
    conds.push(sql`${users.id} in (select support_user_id from organization_support_users)`);
  } else if (ownership === 'none') {
    conds.push(sql`${users.id} not in (select owner_user_id from organizations)`);
  }

  if (enterpriseId) {
    conds.push(sql`(
      ${users.id} in (select staff_user_id from enterprise_staff where enterprise_id = ${enterpriseId})
      or ${users.id} in (select client_user_id from enterprise_clients where enterprise_id = ${enterpriseId})
    )`);
  }

  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  // Distinct column aliases per subquery so Postgres can disambiguate the
  // coalesce() references below.
  const ownedSubquery = db
    .select({
      userId: organizations.ownerUserId,
      ownedN: sql<number>`count(*)::int`.as('owned_n'),
    })
    .from(organizations)
    .groupBy(organizations.ownerUserId)
    .as('owned_sq');

  const supportSubquery = db
    .select({
      userId: organizationSupportUsers.supportUserId,
      supportN: sql<number>`count(*)::int`.as('support_n'),
    })
    .from(organizationSupportUsers)
    .groupBy(organizationSupportUsers.supportUserId)
    .as('support_sq');

  const staffSubquery = db
    .select({
      userId: enterpriseStaff.staffUserId,
      roles: sql<string[]>`array_agg(${enterpriseStaff.role})`.as('roles'),
    })
    .from(enterpriseStaff)
    .groupBy(enterpriseStaff.staffUserId)
    .as('staff_sq');

  // First permission set assigned to a user (alphabetical, deterministic).
  // The User Type column shows this name; when none is assigned we fall
  // back to a label derived from users.role.
  const permSetSubquery = db
    .select({
      userId: userPermissionSets.userId,
      permSetName: sql<string>`min(${permissionSets.name})`.as('perm_set_name'),
    })
    .from(userPermissionSets)
    .innerJoin(permissionSets, eq(permissionSets.id, userPermissionSets.permissionSetId))
    .groupBy(userPermissionSets.userId)
    .as('perm_set_sq');

  const baseQ = db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      ownedCount: sql<number>`coalesce(${ownedSubquery.ownedN}, 0)`.as('owned'),
      supportCount: sql<number>`coalesce(${supportSubquery.supportN}, 0)`.as('support'),
      enterpriseRoles: staffSubquery.roles,
      permissionSetName: permSetSubquery.permSetName,
    })
    .from(users)
    .leftJoin(ownedSubquery, eq(ownedSubquery.userId, users.id))
    .leftJoin(supportSubquery, eq(supportSubquery.userId, users.id))
    .leftJoin(staffSubquery, eq(staffSubquery.userId, users.id))
    .leftJoin(permSetSubquery, eq(permSetSubquery.userId, users.id))
    .orderBy(desc(users.createdAt));

  const totalQ = db.select({ n: sql<number>`count(*)::int` }).from(users);

  const permSetOptionsQ = db
    .select({ id: permissionSets.id, name: permissionSets.name })
    .from(permissionSets)
    .orderBy(permissionSets.name);

  // Enterprises shown in the filter dropdown: orgs marked enterprise OR
  // referenced by enterprise_staff / enterprise_clients (so the filter
  // works even if an org's plan_type hasn't been flipped yet).
  const enterpriseOptionsQ = db
    .selectDistinct({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      sql`${organizations.planType} = 'enterprise'
          or ${organizations.id} in (select enterprise_id from enterprise_staff)
          or ${organizations.id} in (select enterprise_id from enterprise_clients)`,
    )
    .orderBy(organizations.name);

  const filteredQ = whereClause ? baseQ.where(whereClause) : baseQ;

  // Count is run separately from the data query so a timeout here (e.g. a
  // stuck cascade transaction holding locks) doesn't take down the whole
  // page — we just lose the "of N" total and fall back to "X+" pagination.
  const [rows, permSetOptions, enterpriseOptions] = await Promise.all([
    view === 'grouped' ? filteredQ : filteredQ.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    permSetOptionsQ,
    enterpriseOptionsQ,
  ]);

  let total: number | null = null;
  try {
    const [totalRow] = await (whereClause ? totalQ.where(whereClause) : totalQ);
    total = totalRow?.n ?? 0;
  } catch (err) {
    console.warn('[all-users] count query failed:', err instanceof Error ? err.message : err);
    total = null;
  }
  const totalPages = total === null ? null : Math.max(1, Math.ceil(total / PAGE_SIZE));

  // In grouped mode, fetch each visible user's enterprise links (staff + client).
  // A user can appear under multiple enterprises and will render once per group.
  type EnterpriseLink = { userId: string; enterpriseId: string; enterpriseName: string };
  let userEnterpriseLinks: EnterpriseLink[] = [];
  if (view === 'grouped' && rows.length > 0) {
    const visibleIds = rows.map((r) => r.id);
    const [staffLinks, clientLinks] = await Promise.all([
      db
        .select({
          userId: enterpriseStaff.staffUserId,
          enterpriseId: enterpriseStaff.enterpriseId,
          enterpriseName: organizations.name,
        })
        .from(enterpriseStaff)
        .innerJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
        .where(inArray(enterpriseStaff.staffUserId, visibleIds)),
      db
        .select({
          userId: enterpriseClients.clientUserId,
          enterpriseId: enterpriseClients.enterpriseId,
          enterpriseName: organizations.name,
        })
        .from(enterpriseClients)
        .innerJoin(organizations, eq(organizations.id, enterpriseClients.enterpriseId))
        .where(inArray(enterpriseClients.clientUserId, visibleIds)),
    ]);
    userEnterpriseLinks = [...staffLinks, ...clientLinks];
  }

  const filtersBase = { q, type, membership, ownership, enterpriseId, view, page: '1' } as SearchParams;

  return (
    <AdminPage
      title="All Users"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'All Users' }]}
      actions={
        <Link href="/super-admin/all-users/new" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
          + Create User
        </Link>
      }
    >
      {sp.created && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          <div className="font-medium text-emerald-800 dark:text-emerald-200">User created</div>
          {sp.temp ? (
            <div className="mt-1 text-emerald-800 dark:text-emerald-200">
              Temporary password (share with the user — shown only once):
              <code className="ml-2 rounded bg-white px-2 py-0.5 font-mono text-xs dark:bg-zinc-900">{sp.temp}</code>
            </div>
          ) : (
            <div className="mt-1 text-emerald-800 dark:text-emerald-200">
              The user has been notified by email to set their password.
            </div>
          )}
        </div>
      )}
      <Panel>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">System-wide user directory for SuperAdmin</p>

        <form className="mb-3">
          <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Search by name or email..."
              className="flex-1 bg-transparent outline-none placeholder:text-zinc-400"
            />
            {(q || type !== 'all' || membership !== 'all' || ownership !== 'all' || enterpriseId) && (
              <Link href="/super-admin/all-users" className="text-xs text-zinc-500 hover:underline">
                Clear all
              </Link>
            )}
          </div>
          {/* preserve filters */}
          <input type="hidden" name="type" value={type === 'all' ? '' : type} />
          <input type="hidden" name="membership" value={membership === 'all' ? '' : membership} />
          <input type="hidden" name="ownership" value={ownership === 'all' ? '' : ownership} />
        </form>

        <AllUsersFilters
          hasActiveFilters={!!(type !== 'all' || membership !== 'all' || ownership !== 'all' || enterpriseId)}
          clearHref="/super-admin/all-users"
        >
          <div className="mb-2 flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">User Type</span>
              {(['all', 'superadmin', 'user', 'admin', 'staff', 'paying_user', 'investor', 'free_account'] as UserType[]).map((t) => {
                const label =
                  t === 'all'
                    ? 'All'
                    : t === 'superadmin'
                      ? 'SuperAdmin'
                      : t === 'free_account'
                        ? 'Free Account'
                        : t === 'paying_user'
                          ? 'Paying User'
                          : t.charAt(0).toUpperCase() + t.slice(1);
                return (
                  <FilterChip key={t} active={type === t} href={buildHref(filtersBase, { type: t })}>
                    {label}
                  </FilterChip>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">Enterprise Membership</span>
              <FilterChip active={membership === 'all'} href={buildHref(filtersBase, { membership: 'all' })}>All</FilterChip>
              <FilterChip active={membership === 'enterprise'} href={buildHref(filtersBase, { membership: 'enterprise' })}>Enterprise Users Only</FilterChip>
              <FilterChip active={membership === 'non-enterprise'} href={buildHref(filtersBase, { membership: 'non-enterprise' })}>Non-Enterprise Users</FilterChip>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">Company Ownership</span>
              <FilterChip active={ownership === 'all'} href={buildHref(filtersBase, { ownership: 'all' })}>All</FilterChip>
              <FilterChip active={ownership === 'paying'} href={buildHref(filtersBase, { ownership: 'paying' })}>Paying Users Only</FilterChip>
              <FilterChip active={ownership === 'support'} href={buildHref(filtersBase, { ownership: 'support' })}>Support Users Only</FilterChip>
              <FilterChip active={ownership === 'none'} href={buildHref(filtersBase, { ownership: 'none' })}>Users With No Companies</FilterChip>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">Enterprise</span>
              <EnterpriseFilterSelect options={enterpriseOptions} />
              {enterpriseId && (
                <Link
                  href={buildHref(filtersBase, { enterpriseId: '' })}
                  className="text-xs text-zinc-500 hover:underline"
                >
                  Clear
                </Link>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">View</span>
              <FilterChip active={view === 'list'} href={buildHref(filtersBase, { view: 'list' })}>List</FilterChip>
              <FilterChip active={view === 'grouped'} href={buildHref(filtersBase, { view: 'grouped' })}>By Enterprise</FilterChip>
            </div>
          </div>
        </AllUsersFilters>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {view === 'grouped'
            ? `Showing ${rows.length}${total === null ? '' : ` of ${total}`} results grouped by enterprise`
            : `Showing ${rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} to ${(page - 1) * PAGE_SIZE + rows.length}${total === null ? '+' : ` of ${total}`} results`}
          {total === null && (
            <span className="ml-2 italic text-amber-700 dark:text-amber-400">
              (total unavailable — count query timed out)
            </span>
          )}
        </div>

        <div className="mt-2">
          {view === 'grouped' ? (
            <GroupedByEnterpriseUsers
              rows={rows.map((u) => ({
                id: u.id,
                email: u.email,
                fullName: u.fullName ?? null,
                role: u.role,
                isActive: u.isActive,
                createdAt: u.createdAt ?? null,
                lastLoginAt: u.lastLoginAt ?? null,
                ownedCount: Number(u.ownedCount),
                supportCount: Number(u.supportCount),
                enterpriseRoles: u.enterpriseRoles ?? null,
                permissionSetName: u.permissionSetName ?? null,
              }))}
              links={userEnterpriseLinks}
              permissionSets={permSetOptions}
              enterprises={enterpriseOptions}
            />
          ) : (
            <AllUsersTable
              rows={rows.map((u) => ({
                id: u.id,
                email: u.email,
                fullName: u.fullName ?? null,
                role: u.role,
                isActive: u.isActive,
                createdAt: u.createdAt ?? null,
                lastLoginAt: u.lastLoginAt ?? null,
                ownedCount: Number(u.ownedCount),
                supportCount: Number(u.supportCount),
                enterpriseRoles: u.enterpriseRoles ?? null,
                permissionSetName: u.permissionSetName ?? null,
              }))}
              permissionSets={permSetOptions}
              enterprises={enterpriseOptions}
            />
          )}
        </div>

        {view === 'list' && (
          <nav className="mt-3 flex items-center justify-end gap-2 text-sm">
            {page > 1 && (
              <Link href={buildHref(filtersBase, { page: String(page - 1) })} className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                ← Previous
              </Link>
            )}
            <span className="text-xs text-zinc-500">
              Page {page}
              {totalPages !== null && ` of ${totalPages}`}
            </span>
            {(totalPages === null ? rows.length === PAGE_SIZE : page < totalPages) && (
              <Link href={buildHref(filtersBase, { page: String(page + 1) })} className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                Next →
              </Link>
            )}
          </nav>
        )}
      </Panel>
    </AdminPage>
  );
}
