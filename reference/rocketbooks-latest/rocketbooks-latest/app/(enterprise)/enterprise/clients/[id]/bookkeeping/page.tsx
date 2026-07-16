import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseClients, users, organizations, adminAuditLog } from '@/db/schema/schema';
import { AdminPage, Badge, Panel } from '@/components/admin/AdminPage';
import { getCurrentEnterprise, listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { MonthlyTimeline } from '@/components/timeline/MonthlyTimeline';
import { getOrgMonthlyTimelineHistory } from '@/lib/monthly-timeline';
import { getEnterpriseClientHealth, type ClientHealth } from '@/lib/enterprise/client-health';
import { getOutreachMap, type OutreachMap } from '@/lib/enterprise/outreach';
import { getDemoClientDetail } from '@/lib/enterprise/demo';
import { NeedsAttentionQueue } from '../../../_components/NeedsAttentionQueue';
import { OpenBooksButton } from '../../../_components/OpenBooksButton';

export const dynamic = 'force-dynamic';

type View = 'history' | 'needs' | 'comms' | 'activity';
type TimelineHistory = Awaited<ReturnType<typeof getOrgMonthlyTimelineHistory>>;
interface Comm {
  at: Date | string | null;
  issueType: string;
  channel: string | null;
  body: string;
  status: string;
}
interface FirmActivity {
  at: string | null;
  summary: string;
  firmLabel: string;
}

/** Changes the firm made in this client's books (via Open books), attributed to
 * the staff member who made them. Read from admin_audit_log by the indexed
 * target_id (= the client owner user id). */
async function loadFirmActivity(clientUserId: string): Promise<FirmActivity[]> {
  const rows = await db
    .select({
      at: adminAuditLog.timestamp,
      action: adminAuditLog.action,
      metadata: adminAuditLog.auditMetadata,
      firmEmail: users.email,
      firmName: users.fullName,
    })
    .from(adminAuditLog)
    .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
    .where(and(eq(adminAuditLog.targetId, clientUserId), like(adminAuditLog.action, 'firm.edit.%')))
    .orderBy(desc(adminAuditLog.timestamp))
    .limit(100);
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as { summary?: string };
    return {
      at: r.at ?? null,
      summary: meta.summary || r.action.replace('firm.edit.', '').replace(/_/g, ' '),
      firmLabel: r.firmName || r.firmEmail || 'Firm staff',
    };
  });
}

/** This client's outreach messages (outbound), newest first. */
async function loadClientComms(orgId: string): Promise<Comm[]> {
  const rows = (await db.execute(sql`
    select last_contact_at as at, issue_type, channel, last_message_body as body, status
    from ai_client_outreach
    where organization_id = ${orgId} and last_message_body is not null
    order by last_contact_at desc nulls last
    limit 50
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    at: (r.at as string | null) ?? null,
    issueType: String(r.issue_type ?? ''),
    channel: (r.channel as string | null) ?? null,
    body: String(r.body ?? ''),
    status: String(r.status ?? ''),
  }));
}

export default async function ClientBookkeepingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; org?: string }>;
}) {
  const { id } = await params;
  const { view: viewParam, org: orgParam } = await searchParams;
  const view: View =
    viewParam === 'needs' || viewParam === 'comms' || viewParam === 'activity' ? viewParam : 'history';
  const base = `/enterprise/clients/${id}/bookkeeping`;
  // Tab links preserve the selected company (?org=) so switching tabs stays on the
  // business the firm clicked — not the owner's primary org.
  const tabHref = (v?: string) => {
    const parts: string[] = [];
    if (v) parts.push(`view=${v}`);
    if (orgParam) parts.push(`org=${orgParam}`);
    return parts.length ? `${base}?${parts.join('&')}` : base;
  };
  const accountHref = `/enterprise/clients/${id}`;

  const current = await getCurrentEnterprise();
  if (!current) notFound();

  let orgName = '';
  let ownerName: string | null = '';
  let ownerEmail: string | null = '';
  let isDemo = false;
  let history: TimelineHistory = [];
  let healthForClient: ClientHealth | null = null;
  let outreach: OutreachMap = new Map();
  let comms: Comm[] = [];
  let firmActivity: FirmActivity[] = [];
  let openBooksOrgId: string | null = null;

  if (/^demo-user-\d+$/.test(id)) {
    const demo = getDemoClientDetail(id);
    if (!demo) notFound();
    isDemo = true;
    orgName = demo.orgName;
    ownerName = demo.ownerName;
    ownerEmail = demo.ownerEmail;
    history = demo.history;
    healthForClient = demo.health;
    outreach = demo.outreach;
    comms = demo.comms;
  } else {
    const enterprises = await listAccessibleEnterprises();
    const accessibleIds = enterprises.map((e) => e.id);
    const [link] = await db
      .select({ enterpriseId: enterpriseClients.enterpriseId })
      .from(enterpriseClients)
      .where(and(eq(enterpriseClients.clientUserId, id), inArray(enterpriseClients.enterpriseId, accessibleIds)))
      .limit(1);
    if (!link) notFound();
    const [user] = await db
      .select({ email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) notFound();
    const owned = await db
      .select({ id: organizations.id, name: organizations.name, planType: organizations.planType })
      .from(organizations)
      .where(eq(organizations.ownerUserId, id));
    // Honor the specific company the firm clicked (?org=) — validated to belong to
    // this owner. Falls back to their primary (pro, else oldest) when unspecified,
    // so an owner with multiple businesses lands on the RIGHT one, not just the first.
    const clientOrg =
      (orgParam ? owned.find((o) => o.id === orgParam) : undefined) ??
      owned.find((o) => o.planType === 'pro') ??
      owned[0] ??
      null;
    ownerName = user.fullName;
    ownerEmail = user.email;
    orgName = clientOrg?.name ?? user.fullName ?? user.email ?? 'Client';
    openBooksOrgId = clientOrg?.id ?? null;

    if (clientOrg) {
      if (view === 'history') {
        history = await getOrgMonthlyTimelineHistory(clientOrg.id, {
          requestsHref: '/enterprise/communications',
          communicationsHref: '/enterprise/communications',
        });
      } else if (view === 'needs') {
        const firm = await getEnterpriseClientHealth(link.enterpriseId);
        healthForClient = firm.clients.find((c) => c.ownerUserId === id) ?? null;
        outreach = await getOutreachMap([clientOrg.id]);
      } else if (view === 'activity') {
        firmActivity = await loadFirmActivity(id);
      } else {
        comms = await loadClientComms(clientOrg.id);
      }
    }
  }

  const pillClass = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
        : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
    }`;

  const fmtDate = (at: Date | string | null) => {
    if (!at) return '—';
    const d = typeof at === 'string' ? new Date(at) : at;
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  };

  return (
    <AdminPage
      title="Client"
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Clients', href: '/enterprise/clients' },
        { label: orgName },
      ]}
    >
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">{orgName}</h2>
              {isDemo && <Badge tone="zinc">Demo</Badge>}
            </div>
            {(ownerName || ownerEmail) && (
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {ownerName}
                {ownerEmail ? ` · ${ownerEmail}` : ''}
              </p>
            )}
          </div>
          {!isDemo && (
            <div className="flex flex-wrap items-center gap-2">
              {openBooksOrgId && <OpenBooksButton userId={id} orgId={openBooksOrgId} />}
              <Link
                href={`/enterprise/clients/add-company?owner=${id}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                + Add a company
              </Link>
              <Link
                href={accountHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                View account →
              </Link>
            </div>
          )}
        </div>
      </Panel>

      <div className="flex flex-wrap gap-2">
        <Link href={tabHref()} className={pillClass(view === 'history')}>Monthly bookkeeping</Link>
        <Link href={tabHref('needs')} className={pillClass(view === 'needs')}>Needs attention</Link>
        <Link href={tabHref('comms')} className={pillClass(view === 'comms')}>Communications</Link>
        <Link href={tabHref('activity')} className={pillClass(view === 'activity')}>Firm activity</Link>
      </div>

      {view === 'history' && (
        <Panel title="Monthly bookkeeping history">
          {history.length > 0 ? (
            <div className="flex flex-col gap-4">
              {history.map((tl) => (
                <MonthlyTimeline
                  key={`${tl.period.year}-${tl.period.month}`}
                  steps={tl.steps}
                  periodLabel={tl.period.label}
                  defaultOrientation="horizontal"
                  hoverHighlight
                  openBooksAs={openBooksOrgId ? { ownerUserId: id, orgId: openBooksOrgId } : undefined}
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

      {view === 'needs' &&
        (healthForClient ? (
          <NeedsAttentionQueue clients={[healthForClient]} outreach={outreach} demo={isDemo} />
        ) : (
          <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            Nothing needs attention for this client.
          </div>
        ))}

      {view === 'comms' && (
        <Panel title="Communications">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Outreach sent to this client and their replies, newest first.
          </p>
          {comms.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">No communications yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              {comms.map((c, i) => (
                <li key={i} className="flex gap-3 py-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                    →
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{orgName}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{fmtDate(c.at)}</span>
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

      {view === 'activity' && (
        <Panel title="Firm activity">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Changes your firm made in this client&rsquo;s books (via Open books), attributed to the staff member who made
            them — not the client.
          </p>
          {isDemo ? (
            <p className="mt-3 text-sm text-zinc-400">Firm activity isn&rsquo;t tracked for the demo enterprise.</p>
          ) : firmActivity.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">No firm changes recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              {firmActivity.map((a, i) => (
                <li key={i} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-800 dark:text-zinc-100">{a.summary}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">by {a.firmLabel}</p>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-400">{fmtDate(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </AdminPage>
  );
}
