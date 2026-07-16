import Link from 'next/link';
import { sql, desc, eq, gte, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiUsageEvents, users, organizations } from '@/db/schema/schema';
import { AdminPage, MetricTile, Panel, EmptyHint } from '@/components/admin/AdminPage';
import { listRates } from '@/lib/usage/rates';
import {
  RANGE_LABEL,
  RANGE_KEYS,
  parseRange,
  rangeStartIso,
  fmtUsd,
  fmtNum,
  fmtQty,
  fmtTimeAgo,
} from '../_lib/format';
import { buildCostRows } from '../_lib/categories';
import { CostCategoriesTable } from '../_components/CostCategoriesTable';

export const dynamic = 'force-dynamic';

export default async function SuperAdminUserUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { userId } = await params;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const since = rangeStartIso(range);
  const where = and(eq(aiUsageEvents.userId, userId), gte(aiUsageEvents.createdAt, since));

  const [[who], [totals], byFeature, byCategory, rates, recent] = await Promise.all([
    db
      .select({ email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({
        usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
        events: sql<number>`count(*)::int`,
        features: sql<number>`count(distinct ${aiUsageEvents.feature})::int`,
        services: sql<number>`count(distinct ${aiUsageEvents.provider})::int`,
      })
      .from(aiUsageEvents)
      .where(where),
    db
      .select({
        feature: aiUsageEvents.feature,
        usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
        events: sql<number>`count(*)::int`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.feature)
      .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`)),
    db
      .select({
        category: aiUsageEvents.category,
        usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
        qty: sql<number>`coalesce(sum(${aiUsageEvents.quantity}), 0)::float8`,
        events: sql<number>`count(*)::int`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.category),
    listRates(),
    db
      .select({
        id: aiUsageEvents.id,
        createdAt: aiUsageEvents.createdAt,
        orgName: organizations.name,
        provider: aiUsageEvents.provider,
        feature: aiUsageEvents.feature,
        model: aiUsageEvents.model,
        quantity: aiUsageEvents.quantity,
        unit: aiUsageEvents.unit,
        costUsd: aiUsageEvents.costUsd,
      })
      .from(aiUsageEvents)
      .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(50),
  ]);

  const displayName = who?.fullName?.trim() || who?.email || `${userId.slice(0, 8)}…`;

  // Complete cost-category breakdown (all categories, zero-filled) for this user.
  const costRows = buildCostRows(byCategory, rates);

  return (
    <AdminPage
      title={`Usage — ${displayName}`}
      crumbs={[
        { label: 'SuperAdmin' },
        { label: 'Usage & Costs', href: `/super-admin/ai-usage?range=${range}` },
        { label: displayName },
      ]}
      actions={
        <Link
          href={`/super-admin/all-users/${userId}`}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          View user →
        </Link>
      }
    >
      {who?.email && <div className="-mt-2 text-sm text-zinc-500 dark:text-zinc-400">{who.email}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {RANGE_KEYS.map((k) => (
          <Link
            key={k}
            href={`/super-admin/ai-usage/${userId}?range=${k}`}
            className={
              'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
              (range === k
                ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900')
            }
          >
            {RANGE_LABEL[k]}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Total Cost" value={fmtUsd(Number(totals?.usd ?? 0))} />
        <MetricTile label="Total Events" value={fmtNum(totals?.events)} />
        <MetricTile label="Features Used" value={fmtNum(totals?.features)} />
        <MetricTile label="Services Used" value={fmtNum(totals?.services)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`By Feature (${RANGE_LABEL[range]})`}>
          {byFeature.length === 0 ? (
            <EmptyHint>No usage for this user in this range.</EmptyHint>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2">Feature</th>
                  <th className="py-2 text-right">Events</th>
                  <th className="py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {byFeature.map((r) => (
                  <tr key={r.feature}>
                    <td className="py-2 font-mono text-xs">{r.feature}</td>
                    <td className="py-2 text-right">{fmtNum(r.events)}</td>
                    <td className="py-2 text-right font-medium">{fmtUsd(Number(r.usd))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`All Cost Categories (${RANGE_LABEL[range]})`}>
          <CostCategoriesTable rows={costRows} />
        </Panel>
      </div>

      <Panel title="Recent Events (latest 50)">
        {recent.length === 0 ? (
          <EmptyHint>No recent usage.</EmptyHint>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2">When</th>
                  <th className="py-2">Org</th>
                  <th className="py-2">Service</th>
                  <th className="py-2">Feature</th>
                  <th className="py-2">Model</th>
                  <th className="py-2 text-right">Quantity</th>
                  <th className="py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 text-zinc-500">{fmtTimeAgo(r.createdAt)}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">{r.orgName ?? '—'}</td>
                    <td className="py-2">{r.provider}</td>
                    <td className="py-2 font-mono text-xs">{r.feature}</td>
                    <td className="py-2 font-mono text-xs">{r.model}</td>
                    <td className="py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {fmtQty(Number(r.quantity))} {r.unit ?? ''}
                    </td>
                    <td className="py-2 text-right font-medium">{fmtUsd(Number(r.costUsd ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}
