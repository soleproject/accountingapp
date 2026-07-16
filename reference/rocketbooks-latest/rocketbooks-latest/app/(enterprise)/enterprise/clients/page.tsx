import Link from 'next/link';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseClients, organizations, onboardingState, users } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { ClientActionIcons } from '../_components/ClientActionIcons';
import { BulkSetPlan } from '../_components/BulkSetPlan';
import { maybeGetAccountingTier } from '@/lib/accounting/tiers';
import { timeDb } from '@/lib/perf/db-timing';
import { DEMO_ENTERPRISE_ID, getDemoEnterpriseClients } from '@/lib/enterprise/demo';

export const dynamic = 'force-dynamic';

interface SearchParams {
  created?: string;
  temp?: string;
  resent?: string;
}

export default async function EnterpriseClientsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const sessionUser = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) notFound();

// The virtual demo enterprise has no real client users in the DB — render the
  // same synthetic clients shown on its Dashboard / Client Businesses pages.
  if (current.id === DEMO_ENTERPRISE_ID) {
    const demoRows = getDemoEnterpriseClients();
    return (
      <AdminPage
        title="Clients"
        crumbs={[{ label: 'Enterprise' }, { label: 'Clients' }]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/enterprise/clients/import"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Import clients
            </Link>
            <Link
              href="/enterprise/clients/new"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              + Create User
            </Link>
          </div>
        }
      >
        <Panel>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
            Clients of {current.name} ({demoRows.length} {demoRows.length === 1 ? 'client' : 'clients'})
          </p>
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Plan</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">User Status</th>
                  <th className="px-4 py-2.5">Last Login</th>
                  <th className="px-4 py-2.5">Joined</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {demoRows.map((c) => (
                  <tr key={c.userId} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5 font-medium">
                      <Link href={`/enterprise/clients/${c.userId}`} className="text-blue-700 hover:underline dark:text-blue-300">
                        {c.fullName}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{c.email}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-zinc-400" title="Grandfathered flat $89 plan">Legacy $89</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone="green">{c.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={c.isActive ? 'green' : 'red'}>{c.isActive ? 'active' : 'inactive'}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {c.lastSignInAt ? (
                        <span className="text-emerald-700 dark:text-emerald-300">
                          Signed in · {new Date(c.lastSignInAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">Invited — not yet accepted</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-zinc-400">Demo</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </AdminPage>
    );
  }

  // Production hotfix: avoid opening multiple DB sessions at once while this
  // page also performs follow-on per-client lookups.
  const rows = await timeDb('enterprise.clients.rows', () =>
    db
      .select({
        id: enterpriseClients.id,
        status: enterpriseClients.status,
        createdAt: enterpriseClients.createdAt,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        // role drives whether Impersonate is disabled -- you can't impersonate
        // a super admin, so the row-level icon mirrors that guard.
        role: users.role,
      })
      .from(enterpriseClients)
      .leftJoin(users, eq(users.id, enterpriseClients.clientUserId))
      .where(eq(enterpriseClients.enterpriseId, current.id))
      .orderBy(desc(enterpriseClients.createdAt)),
    { route: '/enterprise/clients' },
  );
  const [actor] = await timeDb('enterprise.clients.actorRole', () =>
    db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1),
    { route: '/enterprise/clients' },
  );
  const isDemoOwner = actor?.role === 'enterprise_owner_demo';
  const demoAtCap = isDemoOwner && rows.length >= 1;

  // For each client, decide whether to show the "Complete Onboarding"
  // shortcut. A client is "onboarding incomplete" if they own at least one
  // non-enterprise org with either no onboarding_state row at all (= never
  // started) or completed=false (= in progress). Enterprise plan orgs are
  // excluded since the demo enterprise itself isn't user-onboarded.
  const clientUserIds = rows.map((r) => r.userId).filter((id): id is string => !!id);
  const incompleteRows = clientUserIds.length > 0
    ? await timeDb(
        'enterprise.clients.incompleteOnboarding',
        () =>
          db
            .select({ ownerUserId: organizations.ownerUserId })
            .from(organizations)
            .leftJoin(onboardingState, eq(onboardingState.orgId, organizations.id))
            .where(
              and(
                inArray(organizations.ownerUserId, clientUserIds),
                ne(organizations.planType, 'enterprise'),
                or(isNull(onboardingState.orgId), eq(onboardingState.completed, false)),
              ),
            ),
        { route: '/enterprise/clients', clientCount: clientUserIds.length },
      )
    : [];
  const onboardingIncompleteSet = new Set(incompleteRows.map((r) => r.ownerUserId));

  // A client created in "user creates organizations later" mode owns no book
  // yet, so the query above (which only sees owners of an existing
  // non-enterprise org) can't flag them — but a client with no book at all is
  // the most onboarding-incomplete of all. Treat any client who owns zero
  // non-enterprise orgs as incomplete so the enterprise gets the "Complete
  // Onboarding" CTA right after creating them.
  const ownsNonEnterpriseOrgRows = clientUserIds.length > 0
    ? await db
        .selectDistinct({ ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(
          and(
            inArray(organizations.ownerUserId, clientUserIds),
            ne(organizations.planType, 'enterprise'),
          ),
        )
    : [];
  const ownsNonEnterpriseOrg = new Set(ownsNonEnterpriseOrgRows.map((r) => r.ownerUserId));
  for (const id of clientUserIds) {
    if (!ownsNonEnterpriseOrg.has(id)) onboardingIncompleteSet.add(id);
  }

  // Each client's accounting plan lives on their owned books org (planType='pro').
  // NULL = grandfathered flat $89. Map userId → tier key for the Plan column +
  // the bulk panel. A client owning >1 pro org just shows one (rare).
  const tierRows = clientUserIds.length > 0
    ? await db
        .select({ ownerUserId: organizations.ownerUserId, accountingTier: organizations.accountingTier })
        .from(organizations)
        .where(and(inArray(organizations.ownerUserId, clientUserIds), eq(organizations.planType, 'pro')))
    : [];
  const tierByUser = new Map(tierRows.map((r) => [r.ownerUserId, r.accountingTier ?? '']));
  const bulkClients = rows
    .filter((r) => !!r.userId)
    .map((r) => ({ userId: r.userId!, name: r.fullName ?? r.email ?? '—', tier: tierByUser.get(r.userId!) ?? '' }));

  // Real login / invite status from Supabase auth (users.lastLoginAt is not
  // maintained). last_sign_in_at present = they've signed in (invite accepted);
  // invited_at + no sign-in = invite pending.
  const authStatus = new Map<string, { lastSignInAt: string | null; invited: boolean }>();
  if (clientUserIds.length > 0) {
    const authRows = (await timeDb(
      'enterprise.clients.authStatus',
      () =>
        db.execute(sql`
          select id, last_sign_in_at, invited_at
          from auth.users
          where id in (${sql.join(clientUserIds.map((id) => sql`${id}`), sql`, `)})
        `),
      { route: '/enterprise/clients', clientCount: clientUserIds.length },
    )) as unknown as Array<{ id: string; last_sign_in_at: string | null; invited_at: string | null }>;
    for (const r of authRows) {
      authStatus.set(r.id, { lastSignInAt: r.last_sign_in_at ?? null, invited: !!r.invited_at });
    }
  }

  return (
    <AdminPage
      title="Clients"
      crumbs={[{ label: 'Enterprise' }, { label: 'Clients' }]}
      actions={
        <div className="flex items-center gap-2">
          {!demoAtCap && (
            <Link
              href="/enterprise/clients/import"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Import clients
            </Link>
          )}
          {demoAtCap ? (
            <span
              title="Demo trial is capped at 1 client. Upgrade to add more."
              aria-disabled
              className="cursor-not-allowed rounded-md bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
            >
              + Create User
            </span>
          ) : (
            <Link
              href="/enterprise/clients/new"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              + Create User
            </Link>
          )}
        </div>
      }
    >
      {sp.resent === 'ok' && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          Invite re-sent.
        </div>
      )}
      {sp.resent === 'error' && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          Couldn&rsquo;t resend the invite. Try again, or check email settings.
        </div>
      )}
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
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Clients of {current.name} ({rows.length} {rows.length === 1 ? 'client' : 'clients'})
        </p>
        <BulkSetPlan clients={bulkClients} />
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Plan</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">User Status</th>
                <th className="px-4 py-2.5">Last Login</th>
                <th className="px-4 py-2.5">Joined</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-zinc-500">
                    No clients linked to this enterprise.
                  </td>
                </tr>
              ) : (
                rows.map((c) => {
                  const isSuper = c.role === 'super_admin' || c.role === 'superadmin';
                  return (
                    <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2.5 font-medium">
                        {c.userId ? (
                          <Link href={`/enterprise/clients/${c.userId}`} className="text-blue-700 hover:underline dark:text-blue-300">
                            {c.fullName ?? '—'}
                          </Link>
                        ) : (
                          c.fullName ?? '—'
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{c.email}</td>
                      <td className="px-4 py-2.5">
                        {(() => {
                          const t = c.userId ? maybeGetAccountingTier(tierByUser.get(c.userId)) : null;
                          return t ? (
                            <Badge tone="blue">{t.label}</Badge>
                          ) : (
                            <span className="text-xs text-zinc-400" title="Grandfathered flat $89 plan">Legacy $89</span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={c.status === 'active' ? 'green' : 'zinc'}>{c.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={c.isActive ? 'green' : 'red'}>{c.isActive ? 'active' : 'inactive'}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {(() => {
                          const a = c.userId ? authStatus.get(c.userId) : undefined;
                          if (a?.lastSignInAt) {
                            return (
                              <span className="text-emerald-700 dark:text-emerald-300" title={new Date(a.lastSignInAt).toLocaleString()}>
                                Signed in · {new Date(a.lastSignInAt).toLocaleDateString()}
                              </span>
                            );
                          }
                          if (a?.invited) {
                            return <span className="text-amber-700 dark:text-amber-300">Invited — not yet accepted</span>;
                          }
                          return <span className="text-zinc-400">Never signed in</span>;
                        })()}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                        {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.userId ? (
                          <ClientActionIcons
                            userId={c.userId}
                            userLabel={c.fullName ?? c.email ?? 'this user'}
                            isActive={!!c.isActive}
                            isSuper={isSuper}
                            onboardingIncomplete={onboardingIncompleteSet.has(c.userId)}
                            invitePending={(() => {
                              const a = authStatus.get(c.userId!);
                              // Anyone who's never signed in still needs a way
                              // in — email invite, branded generateLink invite
                              // (no invited_at), or a password they never used.
                              return !a?.lastSignInAt;
                            })()}
                            everInvited={(() => {
                              const a = authStatus.get(c.userId!);
                              return !!a?.invited;
                            })()}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
