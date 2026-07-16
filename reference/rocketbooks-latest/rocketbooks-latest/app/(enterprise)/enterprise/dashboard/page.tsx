import Link from 'next/link';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, adminAuditLog, users } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Badge, MetricTile, Panel } from '@/components/admin/AdminPage';
import { notFound } from 'next/navigation';
import { ClientActionIcons } from '../_components/ClientActionIcons';
import { NeedsAttentionQueue } from '../_components/NeedsAttentionQueue';
import { StartClientReviewButton } from '../_components/StartClientReviewButton';
import { DashboardSpotlightController } from '../_components/DashboardSpotlightController';
import { PeriodFilter } from '../_components/PeriodFilter';
import { DashboardTabs } from '../_components/DashboardTabs';
import { DashboardSearch } from '../_components/DashboardSearch';
import { ClientTimelineToggle } from '../_components/ClientTimelineToggle';
import { MonthlyTimeline } from '@/components/timeline/MonthlyTimeline';
import {
  isEnterpriseTierKey,
  ENTERPRISE_TIERS,
  projectedPartnerMonthlyCents,
} from '@/lib/enterprise/tiers';
import { classifyEnterpriseClients } from '@/lib/enterprise/clients';
import { getEnterpriseClientHealth, resolveDateRange } from '@/lib/enterprise/client-health';
import {
  DEMO_ENTERPRISE_ID,
  DEMO_COUNTS,
  DEMO_ORG,
  DEMO_ACTIVITY,
  getDemoFirmHealth,
  getDemoOutreachMap,
} from '@/lib/enterprise/demo';
import { getOutreachMap } from '@/lib/enterprise/outreach';
import { getEnterpriseOnboardingStatus } from '@/lib/enterprise/onboarding';
import { timeDb } from '@/lib/perf/db-timing';
import { getSession } from '@/lib/auth/session';
import { CustomizableDashboard } from '../_components/CustomizableDashboard';
import { resolveLayout, type DashboardLayout } from '@/lib/enterprise/dashboard-widgets';

export const dynamic = 'force-dynamic';

export default async function EnterpriseDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const range = resolveDateRange(sp.period, sp.from, sp.to);
  const isDemo = current.id === DEMO_ENTERPRISE_ID;

  // counts → tier earnings panel + Total Clients KPI. health → the
  // accounting-pro work surface (KPIs, Needs-Attention queue, client table),
  // scoped to the selected time frame. The Demo Enterprise short-circuits to
  // hand-authored data so every capability shows without touching the DB.
  const { counts, activity, org, health } = isDemo
    ? {
        counts: DEMO_COUNTS,
        activity: DEMO_ACTIVITY,
        org: DEMO_ORG as { name: string; domain: string | null; planType: string | null; tier: string | null; createdAt: string | Date | null },
        health: getDemoFirmHealth(),
      }
    : await (async () => {
        const timingContext = { route: '/enterprise/dashboard', period: sp.period ?? 'default' };
        // Production hotfix: run these DB-heavy dashboard reads sequentially so
        // one SSR request does not consume several Supavisor session slots.
        const counts = await timeDb('enterprise.dashboard.clientCounts', () => classifyEnterpriseClients(current.id), timingContext);
        const activity = await timeDb(
          'enterprise.dashboard.activity',
          () =>
            db
              .select({
                id: adminAuditLog.id,
                action: adminAuditLog.action,
                targetType: adminAuditLog.targetType,
                timestamp: adminAuditLog.timestamp,
                adminEmail: users.email,
              })
              .from(adminAuditLog)
              .leftJoin(users, eq(users.id, adminAuditLog.adminUserId))
              .where(eq(adminAuditLog.targetId, current.id))
              .orderBy(desc(adminAuditLog.timestamp))
              .limit(10),
          timingContext,
        );
        const [org] = await timeDb(
          'enterprise.dashboard.org',
          () =>
            db
              .select({
                name: organizations.name,
                domain: organizations.domain,
                planType: organizations.planType,
                tier: organizations.enterpriseTier,
                createdAt: organizations.createdAt,
              })
              .from(organizations)
              .where(eq(organizations.id, current.id))
              .limit(1),
          timingContext,
        );
        const health = await timeDb('enterprise.dashboard.clientHealth', () => getEnterpriseClientHealth(current.id, range), timingContext);
        return { counts, activity, org, health };
      })();

  // AI outreach state per (client org, issue) → powers the queue's AI columns.
  const outreach = isDemo
    ? getDemoOutreachMap()
    : await timeDb(
        'enterprise.dashboard.outreachMap',
        () => getOutreachMap(health.clients.map((c) => c.orgId)),
        { route: '/enterprise/dashboard', clientCount: health.clients.length },
      );

  const onboarding = await timeDb(
    'enterprise.dashboard.onboarding',
    () => getEnterpriseOnboardingStatus(current.id),
    { route: '/enterprise/dashboard' },
  );

  // Per-user, private dashboard layout (foundation: order + visibility only).
  // Read from the real session user — this is "my view", independent of any
  // client impersonation happening elsewhere in the enterprise area.
  const sessionUser = await getSession();
  const [prefRow] = sessionUser
    ? await db
        .select({ prefs: users.dashboardPrefs })
        .from(users)
        .where(eq(users.id, sessionUser.id))
        .limit(1)
    : [];
  const savedLayout = (prefRow?.prefs && typeof prefRow.prefs === 'object'
    ? (prefRow.prefs as Record<string, unknown>).enterprise
    : null) as Partial<DashboardLayout> | null | undefined;

  const reviewLabel = range ? `Needs Review (${range.label})` : 'Needs Review';
  const aiLabel = range ? `AI Handled (${range.label})` : 'AI Handled (7d)';

  const tier = isEnterpriseTierKey(org?.tier) ? ENTERPRISE_TIERS[org.tier] : null;
  const totalClients = counts.total;
  const capInfo = tier
    ? (() => {
        // Project earnings from paying clients only — trials and
        // no-subscription clients fill cap slots but pay $0 until conversion.
        const projected = projectedPartnerMonthlyCents(tier, counts.paying);
        const spotsLeft = Math.max(0, tier.includedCompaniesCap - totalClients);
        const percentUsed = Math.min(100, Math.round((totalClients / tier.includedCompaniesCap) * 100));
        const overCap = totalClients > tier.includedCompaniesCap;
        // Amber when ≤5 spots left or over cap — partner-facing nudge.
        const isApproaching = !overCap && spotsLeft <= 5;
        return { ...projected, spotsLeft, percentUsed, overCap, isApproaching };
      })()
    : null;

  const nodes: Record<string, React.ReactNode> = {};

  if (!onboarding.completed) {
    nodes['setup-banner'] = (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900/60 dark:bg-blue-950/30">
          <div>
            <div className="font-medium text-blue-900 dark:text-blue-200">Finish setting up your firm</div>
            <div className="text-sm text-blue-700 dark:text-blue-300">
              A quick AI-guided setup configures your branding, pricing, and client experience.
            </div>
          </div>
          <Link
            href="/enterprise/onboarding"
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            Continue setup →
          </Link>
        </div>
    );
  }

  if (tier && capInfo) {
    nodes['tier'] = (
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{tier.label}</h2>
                <Badge tone="amber">{tier.shortLabel}</Badge>
                {capInfo.overCap && <Badge tone="amber">Over included cap</Badge>}
                {capInfo.isApproaching && <Badge tone="amber">{capInfo.spotsLeft} spots left</Badge>}
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                ${(tier.priceCents / 100).toLocaleString()}/{tier.interval} · private label
              </p>
            </div>
            <div className="text-right">
              <div className={`text-3xl font-semibold tabular-nums ${capInfo.overCap ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-900 dark:text-zinc-100'}`}>
                {totalClients}
                <span className="text-base font-normal text-zinc-500"> / {tier.includedCompaniesCap}</span>
              </div>
              <div className="text-xs text-zinc-500">
                {counts.paying} paying
                {counts.trial > 0 && <> · {counts.trial} trial</>}
                {counts.none > 0 && <> · {counts.none} no sub</>}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={`h-full transition-all ${capInfo.overCap ? 'bg-amber-500' : capInfo.isApproaching ? 'bg-amber-400' : 'bg-emerald-500'}`}
              style={{ width: `${capInfo.percentUsed}%` }}
            />
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Projected this month</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                ${(capInfo.totalCents / 100).toLocaleString()}
              </dd>
              <dd className="mt-0.5 text-xs text-zinc-500">
                {counts.paying === 0 && counts.trial > 0 && (
                  <>{counts.trial} {counts.trial === 1 ? 'client' : 'clients'} in trial — earns $0 until conversion</>
                )}
                {counts.paying > 0 && capInfo.preCapClients > 0 && (
                  <>{capInfo.preCapClients} paying × ${(tier.partnerShareCentsPreCap / 100).toFixed(0)}</>
                )}
                {capInfo.postCapClients > 0 && (
                  <>
                    {capInfo.preCapClients > 0 ? ' + ' : ''}
                    {capInfo.postCapClients} × ${(tier.partnerShareCentsPostCap / 100).toFixed(0)} (post-cap)
                  </>
                )}
                {totalClients === 0 && 'Add clients to start earning'}
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Within-cap share</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                ${(tier.partnerShareCentsPreCap / 100).toFixed(0)}
                <span className="text-base font-normal text-zinc-500">/client/mo</span>
              </dd>
              <dd className="mt-0.5 text-xs text-zinc-500">
                Full ${(tier.partnerShareCentsPreCap / 100).toFixed(0)} of the ${(tier.clientPriceCents / 100).toFixed(0)} client price
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Post-cap share</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                ${(tier.partnerShareCentsPostCap / 100).toFixed(0)}
                <span className="text-base font-normal text-zinc-500">/client/mo</span>
              </dd>
              <dd className="mt-0.5 text-xs text-zinc-500">
                After company {tier.includedCompaniesCap} — 50/50 split
              </dd>
            </div>
          </dl>

          {capInfo.isApproaching && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              You have {capInfo.spotsLeft} {capInfo.spotsLeft === 1 ? 'spot' : 'spots'} left at the full ${(tier.partnerShareCentsPreCap / 100).toFixed(0)} share.
              {tier.key === 'pl_495' && ' Upgrade to Private Label Pro for 30 more included spots.'}
              {tier.key === 'pl_995' && ' Upgrade to Certified Partner Level 1 for 140 more included spots.'}
            </div>
          )}
          {capInfo.overCap && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              Clients beyond {tier.includedCompaniesCap} earn ${(tier.partnerShareCentsPostCap / 100).toFixed(0)} each (50/50 split on the ${(tier.partnerShareCentsPreCap / 100).toFixed(0)} share).
              {tier.key === 'pl_495' && ' Upgrade to Private Label Pro to include up to 60 at full share.'}
              {tier.key === 'pl_995' && ' Upgrade to Certified Partner Level 1 to include up to 200 at full share.'}
            </div>
          )}
        </Panel>
    );
  }

  nodes['stats'] = (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Total Clients" value={totalClients} iconColor="text-blue-600 dark:text-blue-400" />
        <MetricTile label={reviewLabel} value={health.totals.needsReview} iconColor="text-amber-600 dark:text-amber-400" />
        <MetricTile label="Clients With Issues" value={health.totals.clientsWithIssues} iconColor="text-red-600 dark:text-red-400" />
        <MetricTile label={aiLabel} value={health.totals.aiHandledThisWeek} iconColor="text-emerald-600 dark:text-emerald-400" />
      </div>
      {health.totals.clientsWithIssues > 0 && (
        <div className="mt-4 flex justify-end">
          <StartClientReviewButton />
        </div>
      )}
    </>
  );

  nodes['attention'] = (
      <DashboardSearch>
      <DashboardTabs
        defaultIndex={1}
        tabs={[
          {
            label: `Client Businesses (${health.clients.length})`,
            content:
          health.clients.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              No active client businesses for this enterprise yet.
            </div>
          ) : (
            <ClientTimelineToggle>
            {/* Compact table — shown when the monthly-timeline toggle is OFF. */}
            <div className="ent-table-view overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2.5">Business</th>
                  <th className="px-4 py-2.5">Owner</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">To review</th>
                  <th className="px-4 py-2.5">Bank</th>
                  <th className="px-4 py-2.5 text-right">Open tasks</th>
                  <th className="px-4 py-2.5">Last activity</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {health.clients.map((c) => {
                  const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
                  const status =
                    c.blockingCount > 0
                      ? { tone: 'red' as const, label: 'Action needed' }
                      : c.needsAttentionCount > 0
                        ? { tone: 'amber' as const, label: 'Review' }
                        : c.onboardingIncomplete
                          ? { tone: 'blue' as const, label: 'Setup' }
                          : { tone: 'green' as const, label: 'Current' };
                  return (
                    <tr
                      key={c.orgId}
                      data-org-row={c.orgId}
                      data-search={`${c.orgName} ${c.ownerName ?? ''} ${c.ownerEmail ?? ''}`}
                      className="border-t border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="px-4 py-2.5 font-medium">
                        <Link href={`/enterprise/clients/${c.ownerUserId}/bookkeeping`} className="hover:underline">
                          {c.orgName}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/enterprise/clients/${c.ownerUserId}`}
                          className="text-blue-700 hover:underline dark:text-blue-300"
                        >
                          {c.ownerName ?? c.ownerEmail}
                        </Link>
                        {c.ownerName && (
                          <span className="ml-2 text-xs text-zinc-500">{c.ownerEmail}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {c.toReview > 0 ? (
                          <span className="font-medium text-amber-700 dark:text-amber-300">{c.toReview}</span>
                        ) : (
                          <span className="text-zinc-400">0</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.brokenBankFeeds > 0 ? (
                          <Badge tone="red">Reconnect</Badge>
                        ) : (
                          <span className="text-xs text-zinc-400">OK</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {c.openTasks}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                        {c.lastActivityAt ? c.lastActivityAt.toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {isDemo ? (
                          <span className="inline-flex justify-end text-xs text-zinc-400">Demo</span>
                        ) : (
                          <ClientActionIcons
                            userId={c.ownerUserId}
                            userLabel={c.ownerName ?? c.ownerEmail ?? 'this user'}
                            isActive={true}
                            isSuper={isSuper}
                            onboardingIncomplete={c.onboardingIncomplete}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
            {/* Shadowed cards with each client's timeline — shown when the toggle is ON. */}
            <div className="ent-cards-view flex flex-col gap-3">
              {health.clients.map((c) => {
                const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
                const status =
                  c.blockingCount > 0
                    ? { tone: 'red' as const, label: 'Action needed' }
                    : c.needsAttentionCount > 0
                      ? { tone: 'amber' as const, label: 'Review' }
                      : c.onboardingIncomplete
                        ? { tone: 'blue' as const, label: 'Setup' }
                        : { tone: 'green' as const, label: 'Current' };
                return (
                  <div
                    key={c.orgId}
                    data-org-row={c.orgId}
                    data-search={`${c.orgName} ${c.ownerName ?? ''} ${c.ownerEmail ?? ''}`}
                    className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 text-sm">
                      <div className="min-w-[160px] flex-1">
                        <div className="font-medium">
                          <Link href={`/enterprise/clients/${c.ownerUserId}/bookkeeping`} className="hover:underline">
                            {c.orgName}
                          </Link>
                        </div>
                        <div className="mt-0.5 text-xs">
                          <Link href={`/enterprise/clients/${c.ownerUserId}`} className="text-blue-700 hover:underline dark:text-blue-300">
                            {c.ownerName ?? c.ownerEmail}
                          </Link>
                          {c.ownerName && <span className="ml-1.5 text-zinc-500">{c.ownerEmail}</span>}
                        </div>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <div className="flex flex-col items-start">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400">To review</span>
                        {c.toReview > 0 ? (
                          <span className="font-medium tabular-nums text-amber-700 dark:text-amber-300">{c.toReview}</span>
                        ) : (
                          <span className="tabular-nums text-zinc-400">0</span>
                        )}
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400">Bank</span>
                        {c.brokenBankFeeds > 0 ? (
                          <Badge tone="red">Reconnect</Badge>
                        ) : (
                          <span className="text-xs text-zinc-400">OK</span>
                        )}
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400">Open tasks</span>
                        <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{c.openTasks}</span>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400">Last activity</span>
                        <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{c.lastActivityAt ? c.lastActivityAt.toLocaleDateString() : '—'}</span>
                      </div>
                      <div className="ml-auto">
                        {isDemo ? (
                          <span className="text-xs text-zinc-400">Demo</span>
                        ) : (
                          <ClientActionIcons
                            userId={c.ownerUserId}
                            userLabel={c.ownerName ?? c.ownerEmail ?? 'this user'}
                            isActive={true}
                            isSuper={isSuper}
                            onboardingIncomplete={c.onboardingIncomplete}
                          />
                        )}
                      </div>
                    </div>
                    <div className="border-t border-zinc-100 bg-zinc-50/40 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/30">
                      <MonthlyTimeline
                        steps={c.timelineSteps}
                        periodLabel={new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                        defaultOrientation="horizontal"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            </ClientTimelineToggle>
          ),
          },
          {
            label: range ? `Needs Attention · ${range.label}` : 'Needs Attention',
            content: (
              <>
                {range && (
                  <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    Showing work dated {range.from} → {range.to}. Bank-connection and onboarding status always reflect today.
                  </p>
                )}
                <NeedsAttentionQueue clients={health.clients} outreach={outreach} demo={isDemo} />
              </>
            ),
          },
          {
            label: 'Pro Attention',
            content: <NeedsAttentionQueue clients={health.clients} outreach={outreach} demo={isDemo} filter="pro" />,
          },
          {
            label: 'AI Attention',
            content: <NeedsAttentionQueue clients={health.clients} outreach={outreach} demo={isDemo} filter="ai" />,
          },
          {
            label: 'Client Attention',
            content: <NeedsAttentionQueue clients={health.clients} outreach={outreach} demo={isDemo} filter="client" />,
          },
        ]}
      />
      </DashboardSearch>
  );

  nodes['recent-activity'] = (
        <Panel title="Recent Activity">
          {activity.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              No recent activity for this enterprise.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium">{a.action}</div>
                    <div className="text-xs text-zinc-500">{a.adminEmail ?? 'system'} · {a.targetType}</div>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {a.timestamp ? new Date(a.timestamp).toLocaleString() : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
  );

  nodes['enterprise-details'] = (
        <Panel title="Enterprise Details">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Name</dt>
              <dd className="font-medium">{org?.name ?? current.name}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Domain</dt>
              <dd>{org?.domain ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Plan</dt>
              <dd>{org?.planType ?? '—'}</dd>
            </div>
            {tier && (
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Tier</dt>
                <dd>{tier.shortLabel}</dd>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Your Role</dt>
              <dd>{current.role}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Established</dt>
              <dd>{org?.createdAt ? new Date(org.createdAt).toLocaleDateString() : '—'}</dd>
            </div>
          </dl>
        </Panel>
  );

  const layout = resolveLayout(savedLayout, Object.keys(nodes));

  return (
    <AdminPage
      title="Enterprise Dashboard"
      crumbs={[{ label: 'Enterprise' }, { label: 'Dashboard' }]}
      actions={<PeriodFilter />}
    >
      <DashboardSpotlightController />
      <CustomizableDashboard nodes={nodes} initialLayout={layout} />
    </AdminPage>
  );
}
