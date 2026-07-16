import Link from 'next/link';
import { sql, desc, eq, gte, and, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiUsageEvents, users, organizations, enterpriseClients, enterpriseStaff } from '@/db/schema/schema';
import { AdminPage, MetricTile, Panel, CollapsiblePanel, EmptyHint } from '@/components/admin/AdminPage';
import { listRates } from '@/lib/usage/rates';
import { RatesPanel } from './_components/RatesPanel';
import { EnterpriseUsageSection, type EntGroup } from './_components/EnterpriseUsageSection';
import { CostCategoriesTable } from './_components/CostCategoriesTable';
import { buildCostRows } from './_lib/categories';
import { timeDb } from '@/lib/perf/db-timing';
import {
  type RangeKey,
  RANGE_LABEL,
  RANGE_KEYS,
  parseRange,
  rangeStartIso,
  fmtUsd,
  fmtNum,
  fmtQty,
  fmtTimeAgo,
} from './_lib/format';

export const dynamic = 'force-dynamic';

export default async function SuperAdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; category?: string }>;
}) {
  const sp = await searchParams;
  const range: RangeKey = parseRange(sp.range);
  const since = rangeStartIso(range);
  const category = typeof sp.category === 'string' && sp.category ? sp.category : null;

  // Shared filter: time range + optional category. Reused across every query.
  const where = (): SQL | undefined => {
    const conds = [gte(aiUsageEvents.createdAt, since)];
    if (category) conds.push(eq(aiUsageEvents.category, category));
    return and(...conds);
  };
  const qLink = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ range, ...(category ? { category } : {}), ...extra });
    return `/super-admin/ai-usage?${p.toString()}`;
  };

  const timingContext = { route: '/super-admin/ai-usage', range, category: category ?? 'all' };
  // Production hotfix: keep this admin page below the Supavisor session-pool
  // ceiling by avoiding a burst of parallel DB clients from one SSR render.
  const [totals] = await timeDb(
    'aiUsage.totals',
    () =>
      db
        .select({
          usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
          userCount: sql<number>`count(distinct ${aiUsageEvents.userId})::int`,
        })
        .from(aiUsageEvents)
        .where(where()),
    timingContext,
  );
  // Per-category aggregate — range-scoped but NOT category-filtered, so it
  // powers BOTH the filter chips and the full "All Cost Categories" panel
  // (always shows every category, zero-filled).
  const categories = await timeDb(
    'aiUsage.categories',
    () =>
      db
        .select({
          category: aiUsageEvents.category,
          usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
          qty: sql<number>`coalesce(sum(${aiUsageEvents.quantity}), 0)::float8`,
          events: sql<number>`count(*)::int`,
        })
        .from(aiUsageEvents)
        .where(gte(aiUsageEvents.createdAt, since))
        .groupBy(aiUsageEvents.category)
        .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`)),
    timingContext,
  );
  const byUser = await timeDb(
    'aiUsage.byUser',
    () =>
      db
        .select({
          userId: aiUsageEvents.userId,
          email: users.email,
          usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(aiUsageEvents)
        .leftJoin(users, eq(users.id, aiUsageEvents.userId))
        .where(where())
        .groupBy(aiUsageEvents.userId, users.email)
        .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`)),
    timingContext,
  );
  const byFeature = await timeDb(
    'aiUsage.byFeature',
    () =>
      db
        .select({
          feature: aiUsageEvents.feature,
          usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(aiUsageEvents)
        .where(where())
        .groupBy(aiUsageEvents.feature)
        .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`)),
    timingContext,
  );
  const byModel = await timeDb(
    'aiUsage.byModel',
    () =>
      db
        .select({
          model: aiUsageEvents.model,
          usd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(aiUsageEvents)
        .where(where())
        .groupBy(aiUsageEvents.model)
        .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`)),
    timingContext,
  );
  const recent = await timeDb(
    'aiUsage.recent',
    () =>
      db
        .select({
          id: aiUsageEvents.id,
          createdAt: aiUsageEvents.createdAt,
          email: users.email,
          orgName: organizations.name,
          provider: aiUsageEvents.provider,
          feature: aiUsageEvents.feature,
          category: aiUsageEvents.category,
          model: aiUsageEvents.model,
          quantity: aiUsageEvents.quantity,
          unit: aiUsageEvents.unit,
          costUsd: aiUsageEvents.costUsd,
          latencyMs: aiUsageEvents.latencyMs,
        })
        .from(aiUsageEvents)
        .leftJoin(users, eq(users.id, aiUsageEvents.userId))
        .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
        .where(where())
        .orderBy(desc(aiUsageEvents.createdAt))
        .limit(50),
    timingContext,
  );
  const rates = await timeDb('aiUsage.rates', () => listRates(), timingContext);

  const avgPerCall = totals && totals.calls > 0 ? Number(totals.usd) / totals.calls : 0;

  // Full cost-category breakdown (all services, zero-filled) — same view as the
  // per-user page. Driven by the range-scoped `categories` aggregate.
  const costRows = buildCostRows(categories, rates);

  // Roll usage up by enterprise: map each user → the enterprise it belongs to
  // (client membership wins over staff), then group. Null-user (system) events
  // form their own group; users with no enterprise fall into "No enterprise".
  const userIds = byUser.map((u) => u.userId).filter((x): x is string => !!x);
  const clientLinks = userIds.length
    ? await timeDb(
        'aiUsage.enterpriseClientLinks',
        () =>
          db
            .select({ userId: enterpriseClients.clientUserId, entId: enterpriseClients.enterpriseId })
            .from(enterpriseClients)
            .where(inArray(enterpriseClients.clientUserId, userIds)),
        { ...timingContext, userCount: userIds.length },
      )
    : [] as { userId: string; entId: string }[];
  const staffLinks = userIds.length
    ? await timeDb(
        'aiUsage.enterpriseStaffLinks',
        () =>
          db
            .select({ userId: enterpriseStaff.staffUserId, entId: enterpriseStaff.enterpriseId })
            .from(enterpriseStaff)
            .where(inArray(enterpriseStaff.staffUserId, userIds)),
        { ...timingContext, userCount: userIds.length },
      )
    : [] as { userId: string; entId: string }[];
  const userToEnt = new Map<string, string>();
  for (const s of staffLinks) if (!userToEnt.has(s.userId)) userToEnt.set(s.userId, s.entId);
  for (const c of clientLinks) userToEnt.set(c.userId, c.entId); // client membership wins
  const entIds = [...new Set(userToEnt.values())];
  const entOrgs = entIds.length
    ? await timeDb(
        'aiUsage.enterpriseNames',
        () =>
          db
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(inArray(organizations.id, entIds)),
        { ...timingContext, enterpriseCount: entIds.length },
      )
    : [];
  const entName = new Map(entOrgs.map((o) => [o.id, o.name]));

  const groupMap = new Map<string, EntGroup>();
  const ensureGroup = (key: string, name: string, isSystem = false): EntGroup => {
    let g = groupMap.get(key);
    if (!g) {
      g = { key, name, events: 0, cost: 0, users: [], isSystem };
      groupMap.set(key, g);
    }
    return g;
  };
  for (const u of byUser) {
    const cost = Number(u.usd);
    const events = Number(u.calls);
    if (!u.userId) {
      const g = ensureGroup('__system__', 'System / background', true);
      g.events += events;
      g.cost += cost;
      g.users.push({ userId: null, email: null, events, cost });
      continue;
    }
    const entId = userToEnt.get(u.userId) ?? null;
    const key = entId ?? '__none__';
    const name = entId ? entName.get(entId) ?? 'Unknown enterprise' : 'No enterprise';
    const g = ensureGroup(key, name);
    g.events += events;
    g.cost += cost;
    g.users.push({ userId: u.userId, email: u.email, events, cost });
  }
  const enterpriseGroups = [...groupMap.values()].sort((a, b) => b.cost - a.cost);
  for (const g of enterpriseGroups) g.users.sort((a, b) => b.cost - a.cost);

  return (
    <AdminPage title="Usage & Costs" crumbs={[{ label: 'SuperAdmin' }, { label: 'Usage & Costs' }]}>
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_KEYS.map((k) => (
          <Link
            key={k}
            href={qLink({ range: k })}
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

      {/* Category filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={qLink({ category: '' })}
          className={
            'rounded-full border px-3 py-1 text-xs transition-colors ' +
            (!category
              ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
              : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900')
          }
        >
          All categories
        </Link>
        {categories
          .filter((c) => c.category)
          .map((c) => (
            <Link
              key={c.category}
              href={qLink({ category: c.category as string })}
              className={
                'rounded-full border px-3 py-1 text-xs transition-colors ' +
                (category === c.category
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900')
              }
            >
              {c.category} · {fmtUsd(Number(c.usd))}
            </Link>
          ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Total Cost" value={fmtUsd(Number(totals?.usd ?? 0))} />
        <MetricTile label="Total Events" value={fmtNum(totals?.calls)} />
        <MetricTile label="Unique Users" value={fmtNum(totals?.userCount)} />
        <MetricTile label="Avg Cost / Event" value={fmtUsd(avgPerCall)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`By Feature (${RANGE_LABEL[range]})`}>
          {byFeature.length === 0 ? (
            <EmptyHint>No data.</EmptyHint>
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
                    <td className="py-2 text-right">{fmtNum(r.calls)}</td>
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

      <EnterpriseUsageSection groups={enterpriseGroups} range={range} />

      <Panel title={`By Model / Sub-type (${RANGE_LABEL[range]})`}>
        {byModel.length === 0 ? (
          <EmptyHint>No data.</EmptyHint>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="py-2">Model</th>
                <th className="py-2 text-right">Events</th>
                <th className="py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {byModel.map((r) => (
                <tr key={r.model}>
                  <td className="py-2 font-mono text-xs">{r.model}</td>
                  <td className="py-2 text-right">{fmtNum(r.calls)}</td>
                  <td className="py-2 text-right font-medium">{fmtUsd(Number(r.usd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <CollapsiblePanel title="Recent Events (latest 50)">
        {recent.length === 0 ? (
          <EmptyHint>No recent usage.</EmptyHint>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2">When</th>
                  <th className="py-2">User</th>
                  <th className="py-2">Org</th>
                  <th className="py-2">Service</th>
                  <th className="py-2">Feature</th>
                  <th className="py-2">Model</th>
                  <th className="py-2 text-right">Quantity</th>
                  <th className="py-2 text-right">Latency</th>
                  <th className="py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 text-zinc-500">{fmtTimeAgo(r.createdAt)}</td>
                    <td className="py-2">{r.email ?? <span className="text-zinc-500">—</span>}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">{r.orgName ?? '—'}</td>
                    <td className="py-2">{r.provider}</td>
                    <td className="py-2 font-mono text-xs">{r.feature}</td>
                    <td className="py-2 font-mono text-xs">{r.model}</td>
                    <td className="py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {fmtQty(Number(r.quantity))} {r.unit ?? ''}
                    </td>
                    <td className="py-2 text-right text-zinc-500">
                      {r.latencyMs == null ? '—' : `${r.latencyMs}ms`}
                    </td>
                    <td className="py-2 text-right font-medium">{fmtUsd(Number(r.costUsd ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsiblePanel>

      <RatesPanel rates={rates} />
    </AdminPage>
  );
}
