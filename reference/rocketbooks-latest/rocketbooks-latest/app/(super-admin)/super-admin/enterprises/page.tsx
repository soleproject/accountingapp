import Link from 'next/link';
import { sql, eq, ilike, or, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users, enterpriseStaff, enterpriseClients } from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { ENTERPRISE_TIERS, isEnterpriseTierKey } from '@/lib/enterprise/tiers';

export const dynamic = 'force-dynamic';

interface SearchParams {
  q?: string;
}

export default async function EnterprisesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { q } = await searchParams;
  const search = (q ?? '').trim();

  // An "enterprise" here = any org that has staff/clients in the enterprise tables,
  // OR has plan_type='enterprise'. Aggregate the related counts in a single query.
  // Distinct column aliases per CTE so the coalesce / where references aren't ambiguous.
  const staffCount = db.$with('staff_count').as(
    db
      .select({ enterpriseId: enterpriseStaff.enterpriseId, staffN: sql<number>`count(*)::int`.as('staff_n') })
      .from(enterpriseStaff)
      .groupBy(enterpriseStaff.enterpriseId),
  );
  const clientCount = db.$with('client_count').as(
    db
      .select({ enterpriseId: enterpriseClients.enterpriseId, clientN: sql<number>`count(*)::int`.as('client_n') })
      .from(enterpriseClients)
      .groupBy(enterpriseClients.enterpriseId),
  );

  let qb = db
    .with(staffCount, clientCount)
    .select({
      id: organizations.id,
      name: organizations.name,
      domain: organizations.domain,
      planType: organizations.planType,
      tier: organizations.enterpriseTier,
      createdAt: organizations.createdAt,
      ownerEmail: users.email,
      ownerName: users.fullName,
      staff: sql<number>`coalesce(${staffCount.staffN}, 0)`.as('staff'),
      clients: sql<number>`coalesce(${clientCount.clientN}, 0)`.as('clients'),
    })
    .from(organizations)
    .leftJoin(users, eq(users.id, organizations.ownerUserId))
    .leftJoin(staffCount, eq(staffCount.enterpriseId, organizations.id))
    .leftJoin(clientCount, eq(clientCount.enterpriseId, organizations.id))
    .where(
      sql`(${organizations.planType} = 'enterprise' or ${staffCount.staffN} > 0 or ${clientCount.clientN} > 0)`,
    )
    .orderBy(desc(organizations.createdAt))
    .$dynamic();

  if (search) {
    qb = qb.where(
      or(
        ilike(organizations.name, `%${search}%`),
        ilike(organizations.domain, `%${search}%`),
      )!,
    );
  }

  const rows = await qb;

  return (
    <AdminPage
      title="Enterprises"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Enterprises' }]}
      actions={
        <Link
          href="/super-admin/enterprises/new"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          + Create Enterprise
        </Link>
      }
    >
      <Panel>
        <form className="mb-4">
          <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              name="q"
              defaultValue={search}
              placeholder="Search enterprises…"
              className="flex-1 bg-transparent outline-none placeholder:text-zinc-400"
            />
            {search && (
              <Link href="/super-admin/enterprises" className="text-xs text-zinc-500 hover:underline">
                Clear
              </Link>
            )}
          </div>
        </form>

        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Domain</th>
                <th className="px-4 py-2.5">Tier</th>
                <th className="px-4 py-2.5">Owner</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Clients</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-zinc-500">
                    {search ? 'No enterprises match your search.' : 'No enterprises yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const tier = isEnterpriseTierKey(r.tier) ? ENTERPRISE_TIERS[r.tier] : null;
                  const clientCountValue = Number(r.clients);
                  const overCap = tier !== null && clientCountValue > tier.includedCompaniesCap;
                  return (
                    <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2.5">
                        <Link href={`/super-admin/enterprises/${r.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{r.domain ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        {tier ? (
                          <div className="flex flex-col">
                            <span className="font-medium text-zinc-800 dark:text-zinc-200">{tier.shortLabel}</span>
                            <span className="text-xs text-zinc-500">{tier.includedCompaniesCap} included</span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-zinc-800 dark:text-zinc-200">{r.ownerName ?? 'Unknown'}</div>
                        <div className="text-xs text-zinc-500">{r.ownerEmail ?? '—'}</div>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                        {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone="green">Active</Badge>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        <span className={overCap ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-zinc-700 dark:text-zinc-300'}>
                          {tier ? `${clientCountValue} / ${tier.includedCompaniesCap}` : clientCountValue}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={`/super-admin/enterprises/${r.id}`} className="text-xs text-blue-700 hover:underline dark:text-blue-300">
                          View →
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Showing {rows.length} {rows.length === 1 ? 'enterprise' : 'enterprises'}
        </div>
      </Panel>
    </AdminPage>
  );
}
