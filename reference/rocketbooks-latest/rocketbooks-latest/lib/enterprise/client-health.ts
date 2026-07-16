import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { buildTimelineSteps, type MilestoneStep } from '@/lib/monthly-timeline';

/**
 * Per-client "state of the books" for the accounting-firm dashboard. Mirrors
 * the signal definitions in lib/server/action-cards.ts (which computes the
 * same cards for a single org), but rolled up across ALL of a firm's client
 * orgs in one round-trip via GROUP BY — so a 200-client firm costs one query,
 * not 200 × ~11. Keep the predicates here in sync with action-cards.ts.
 *
 * "Blocking" signals (broken bank feed, unfinished onboarding) mean the books
 * literally can't move forward; everything else is normal-priority work.
 */
export interface ClientHealth {
  orgId: string;
  orgName: string;
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerRole: string | null;
  /** Per-business responsibility matrix (jsonb) + who keeps the books — used to
   *  route each signal to the Pro/Client tab by the firm's per-company choice. */
  taskResponsibilities: unknown;
  booksManagedBy: string | null;
  /** Firm-wide default matrix (same for every client of this enterprise) — the
   *  middle tier of resolution: client override → this → smart default. */
  enterpriseDefaults: unknown;
  // ── signals ──────────────────────────────────────────────────────
  brokenBankFeeds: number;       // plaid items needing reconnect (blocking)
  onboardingIncomplete: boolean; // (blocking)
  toReview: number;              // unreviewed deposits + withdrawals (deposits_to_review + uncat_to_review)
  toReviewOldestDays: number | null;
  depositsToReview: number;      // type='deposit' AND reviewed IS NOT TRUE (stepper: Review Deposits)
  aiToVerify: number;            // reviewed=true AND verified=false (stepper: Review AI Categorized)
  uncategorizedToReview: number; // type='withdrawal' AND reviewed IS NOT TRUE (stepper: Uncategorized Spending)
  reconOff: number;              // OPEN reconciliation periods, difference != 0
  openFindings: number;          // OPEN book_review_findings (duplicate/integrity/anomaly)
  overdueBills: number;
  overdueInvoices: number;
  openTasks: number;
  pendingMeetingFollowups: number;
  aiHandledThisWeek: number;     // AI auto-confirmed categorizations on import, last 7d
  lastActivityAt: Date | null;
  // ── derived ──────────────────────────────────────────────────────
  /**
   * Count of book-blocking signals (drives 🔴 status + sort). Only a broken
   * bank feed qualifies — onboarding-incomplete is tracked separately
   * (onboardingIncomplete) because for firm-managed clients it's near-
   * universal and would otherwise flood the queue.
   */
  blockingCount: number;
  /** Distinct active book-work signals — excludes onboarding (its own flag). */
  needsAttentionCount: number;
  /** Pre-built monthly bookkeeping timeline steps for this client (current month). */
  timelineSteps: MilestoneStep[];
}

export interface FirmHealth {
  /** Sorted worst-first: blocking desc, then needs-attention desc. */
  clients: ClientHealth[];
  totals: {
    /** Σ transactions awaiting review across all clients. */
    needsReview: number;
    /** Clients with ≥1 actionable item. */
    clientsWithIssues: number;
    /** Σ auto-categorizations the AI applied this week. */
    aiHandledThisWeek: number;
    /** Stand-in for "waiting on client" until a requests table exists. */
    waitingOnClient: number;
  };
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 10) || 0;
  return 0;
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * Compute the firm-wide client health board. Pure data-fetching — no auth.
 * Excludes the firm's own enterprise org (plan_type='enterprise') and any
 * deactivated client owners (is_active=false), so disabled/junk signups drop
 * out of both the queue and the counts.
 */
export interface DateRange {
  /** inclusive start, yyyy-mm-dd */
  from: string;
  /** inclusive end, yyyy-mm-dd */
  to: string;
  /** exclusive end (day after `to`), yyyy-mm-dd — for `< toExclusive` compares */
  toExclusive: string;
  /** short human label for KPIs, e.g. "May" or "Jun 1 – Jun 7" */
  label: string;
}

/**
 * Turn a dashboard period selection into a concrete date range, or null for
 * "all open" (no date scoping). Presets: 'this_month' | 'last_month'. A custom
 * range is supplied via from/to (yyyy-mm-dd). Anything else → null.
 */
export function resolveDateRange(period?: string, from?: string, to?: string): DateRange | null {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const dayAfter = (iso: string) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return fmt(d);
  };
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthLabel = (yr: number, mo: number) =>
    new Date(Date.UTC(yr, mo, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) +
    (yr !== y ? ` ${yr}` : '');

  if (period === 'this_month') {
    const f = fmt(new Date(Date.UTC(y, m, 1)));
    const t = fmt(new Date(Date.UTC(y, m + 1, 0)));
    return { from: f, to: t, toExclusive: dayAfter(t), label: monthLabel(y, m) };
  }
  if (period === 'last_month') {
    const yr = m === 0 ? y - 1 : y;
    const mo = m === 0 ? 11 : m - 1;
    const f = fmt(new Date(Date.UTC(yr, mo, 1)));
    const t = fmt(new Date(Date.UTC(yr, mo + 1, 0)));
    return { from: f, to: t, toExclusive: dayAfter(t), label: monthLabel(yr, mo) };
  }
  if (from && to) {
    return { from, to, toExclusive: dayAfter(to), label: `${from} → ${to}` };
  }
  return null;
}

export async function getEnterpriseClientHealth(
  enterpriseId: string,
  range?: DateRange | null,
): Promise<FirmHealth> {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Current-month bounds for the per-client bookkeeping timeline signals
  // (close status, reconciled-this-month) — always "this month" regardless of
  // the dashboard's period filter.
  const nowD = new Date();
  const curYear = nowD.getUTCFullYear();
  const curMonth = nowD.getUTCMonth() + 1; // 1-based
  const monthStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  // When a period is selected, date-based signals scope to it ("what dated in
  // this window still isn't done"); state signals (broken bank feed, onboarding)
  // are always current. Default (no range) = all open items, AI measured over 7d.
  const txRange = range ? sql`and date >= ${range.from} and date < ${range.toExclusive}` : sql``;
  const reconRange = range ? sql`and start_date <= ${range.to} and end_date >= ${range.from}` : sql``;
  const billsRange = range
    ? sql`and due_date >= ${range.from} and due_date < ${range.toExclusive}`
    : sql`and due_date < ${today}`;
  const invoicesRange = range
    ? sql`and due_date >= ${range.from} and due_date < ${range.toExclusive}`
    : sql`and due_date < ${today}`;
  const tasksRange = range ? sql`and due_date >= ${range.from} and due_date < ${range.toExclusive}` : sql``;
  const followupsRange = range
    ? sql`and meeting_ended_at >= ${range.from} and meeting_ended_at < ${range.toExclusive}`
    : sql``;
  const aiRange = range
    ? sql`and created_at >= ${range.from} and created_at < ${range.toExclusive}`
    : sql`and created_at >= ${weekAgo}`;

  const result = await db.execute(sql`
    with client_orgs as (
      select o.id as org_id, o.name as org_name, o.owner_user_id,
             o.task_responsibilities, o.books_managed_by,
             u.full_name, u.email, u.role
      from organizations o
      join users u on u.id = o.owner_user_id
      where o.owner_user_id in (
              select client_user_id from enterprise_clients where enterprise_id = ${enterpriseId}
            )
        and o.plan_type <> 'enterprise'
        and u.is_active is true
    ),
    broken_plaid as (
      select linked_organization_id as org_id, count(distinct plaid_item_id)::int as n
      from plaid_accounts
      where in_scope is true
        and (connection_status <> 'connected' or sync_status = 'error')
        and linked_organization_id in (select org_id from client_orgs)
      group by linked_organization_id
    ),
    to_review as (
      -- Split the transaction-review work into the three stepper buckets so the
      -- queue can route them separately (Review AI Categorized follows the
      -- responsibility radial; Deposits + Uncategorized are always the client's).
      -- Predicates mirror app/(app)/transactions/page.tsx exactly.
      select organization_id as org_id,
             count(*) filter (where type = 'deposit' and reviewed is not true)::int as deposits_n,
             count(*) filter (where reviewed = true and verified = false)::int as ai_verify_n,
             count(*) filter (where type = 'withdrawal' and reviewed is not true)::int as uncat_n,
             min(date) filter (where reviewed is not true) as oldest
      from transactions
      where organization_id in (select org_id from client_orgs) ${txRange}
      group by organization_id
    ),
    recon_off as (
      select organization_id as org_id, count(*)::int as n
      from reconciliation_periods
      where status = 'OPEN' and difference is not null and difference <> 0 ${reconRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    overdue_bills as (
      select organization_id as org_id, count(distinct id)::int as n
      from bills
      where status = 'posted' ${billsRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    overdue_invoices as (
      select organization_id as org_id, count(distinct id)::int as n
      from invoices
      where status <> 'paid' and posted is true ${invoicesRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    onboarding as (
      select org_id, completed from onboarding_state
      where org_id in (select org_id from client_orgs)
    ),
    open_tasks as (
      -- Exclude generated recurring tasks; they surface as their own due-date-
      -- gated rows (Pro/Client Attention), so this count stays ad-hoc tasks.
      select organization_id as org_id, count(*)::int as n
      from tasks
      where status = 'OPEN' and source is distinct from 'recurring' ${tasksRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    followups as (
      select organization_id as org_id, count(*)::int as n
      from meeting_followups
      where state <> 'completed' ${followupsRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    ai_week as (
      -- AI's auto-confirmed categorizations on import — the populated signal
      -- of the bot doing work. (auto_categorization_actions is unused in prod.)
      select organization_id as org_id, count(*)::int as n
      from imported_transactions
      where auto_confirmed is true ${aiRange}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    last_activity as (
      select org_id, max(created_at) as last_at
      from activity_feed
      where org_id in (select org_id from client_orgs)
      group by org_id
    ),
    findings as (
      select organization_id as org_id, count(*)::int as n
      from book_review_findings
      where status = 'open'
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    close_status as (
      select organization_id as org_id, max(status) as status
      from accounting_periods
      where year = ${curYear} and month = ${curMonth}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    recon_done as (
      select organization_id as org_id, count(*)::int as n
      from reconciliation_periods
      where status = 'RECONCILED' and start_date <= ${monthEnd} and end_date >= ${monthStart}
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    outreach as (
      select organization_id as org_id,
             count(*)::int as n,
             (count(*) filter (where status = 'awaiting_response'))::int as awaiting_n
      from ai_client_outreach
      where status in ('drafted', 'sent', 'awaiting_response')
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    threads as (
      select organization_id as org_id, count(distinct coalesce(thread_id, id))::int as n
      from inbox_messages
      where status = 'open'
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    ),
    receipts_pending as (
      select organization_id as org_id, count(*)::int as n
      from receipts
      where posted = false
        and organization_id in (select org_id from client_orgs)
      group by organization_id
    )
    select
      c.org_id, c.org_name, c.owner_user_id, c.task_responsibilities, c.books_managed_by, c.full_name, c.email, c.role,
      coalesce(bp.n, 0) as broken_bank_feeds,
      coalesce(tr.deposits_n, 0) as deposits_to_review,
      coalesce(tr.ai_verify_n, 0) as ai_to_verify,
      coalesce(tr.uncat_n, 0) as uncat_to_review,
      coalesce(tr.deposits_n, 0) + coalesce(tr.uncat_n, 0) as to_review,
      tr.oldest as to_review_oldest,
      coalesce(ro.n, 0) as recon_off,
      coalesce(ob.n, 0) as overdue_bills,
      coalesce(oi.n, 0) as overdue_invoices,
      (ons.org_id is null or ons.completed is not true) as onboarding_incomplete,
      coalesce(ot.n, 0) as open_tasks,
      coalesce(fu.n, 0) as pending_followups,
      coalesce(aw.n, 0) as ai_handled_week,
      coalesce(f.n, 0) as open_findings,
      cs.status as close_status,
      coalesce(rd.n, 0) as reconciled_month,
      coalesce(ou.n, 0) as open_outreach,
      coalesce(ou.awaiting_n, 0) as awaiting_client,
      coalesce(th.n, 0) as open_threads,
      coalesce(rp.n, 0) as pending_receipts,
      la.last_at as last_activity_at
    from client_orgs c
    left join broken_plaid bp on bp.org_id = c.org_id
    left join to_review tr on tr.org_id = c.org_id
    left join recon_off ro on ro.org_id = c.org_id
    left join overdue_bills ob on ob.org_id = c.org_id
    left join overdue_invoices oi on oi.org_id = c.org_id
    left join onboarding ons on ons.org_id = c.org_id
    left join open_tasks ot on ot.org_id = c.org_id
    left join followups fu on fu.org_id = c.org_id
    left join ai_week aw on aw.org_id = c.org_id
    left join last_activity la on la.org_id = c.org_id
    left join findings f on f.org_id = c.org_id
    left join close_status cs on cs.org_id = c.org_id
    left join recon_done rd on rd.org_id = c.org_id
    left join outreach ou on ou.org_id = c.org_id
    left join threads th on th.org_id = c.org_id
    left join receipts_pending rp on rp.org_id = c.org_id
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;

  const entDefRows = await db.execute(
    sql`select enterprise_default_responsibilities as d from organizations where id = ${enterpriseId} limit 1`,
  );
  const entDefList = Array.isArray(entDefRows) ? entDefRows : ((entDefRows as { rows?: unknown[] }).rows ?? []);
  const enterpriseDefaults = (entDefList[0] as { d?: unknown } | undefined)?.d ?? null;

  const clients: ClientHealth[] = rows.map((r) => {
    const brokenBankFeeds = toInt(r.broken_bank_feeds);
    const onboardingIncomplete = r.onboarding_incomplete === true;
    const toReview = toInt(r.to_review);
    const depositsToReview = toInt(r.deposits_to_review);
    const aiToVerify = toInt(r.ai_to_verify);
    const uncategorizedToReview = toInt(r.uncat_to_review);
    const reconOff = toInt(r.recon_off);
    const openFindings = toInt(r.open_findings);
    const overdueBills = toInt(r.overdue_bills);
    const overdueInvoices = toInt(r.overdue_invoices);
    const openTasks = toInt(r.open_tasks);
    const pendingMeetingFollowups = toInt(r.pending_followups);

    const blockingCount = brokenBankFeeds > 0 ? 1 : 0;
    // One queue row per active book-work signal — matches what the queue
    // renders. Onboarding is excluded (it's the table's "Setup" status, not a
    // book-work item) so a wall of identical onboarding rows can't bury real work.
    const needsAttentionCount =
      brokenBankFeeds +
      reconOff +
      (openFindings > 0 ? 1 : 0) +
      (overdueBills > 0 ? 1 : 0) +
      (overdueInvoices > 0 ? 1 : 0) +
      (depositsToReview > 0 ? 1 : 0) +
      (aiToVerify > 0 ? 1 : 0) +
      (uncategorizedToReview > 0 ? 1 : 0) +
      (openTasks > 0 ? 1 : 0) +
      (pendingMeetingFollowups > 0 ? 1 : 0);

    const lastIso = toStr(r.last_activity_at);

    // Build this client's monthly bookkeeping timeline from the rolled-up
    // signals (no per-client query). Requests/comms route to the firm comms hub.
    const closeStatusRaw = toStr(r.close_status);
    const timelineSteps = buildTimelineSteps(
      {
        toReview,
        reconOff,
        reconciledThisMonth: toInt(r.reconciled_month),
        openFindings: toInt(r.open_findings),
        closeStatus:
          closeStatusRaw === 'closed' || closeStatusRaw === 'reviewed' || closeStatusRaw === 'open'
            ? closeStatusRaw
            : 'none',
        openOutreach: toInt(r.open_outreach),
        awaitingClient: toInt(r.awaiting_client),
        pendingReceipts: toInt(r.pending_receipts),
        openThreads: toInt(r.open_threads),
        overdueBills,
        overdueInvoices,
      },
      { requestsHref: '/enterprise/communications', communicationsHref: '/enterprise/communications' },
    );

    return {
      orgId: String(r.org_id),
      orgName: toStr(r.org_name) ?? '—',
      ownerUserId: String(r.owner_user_id),
      ownerName: toStr(r.full_name),
      ownerEmail: toStr(r.email),
      ownerRole: toStr(r.role),
      taskResponsibilities: r.task_responsibilities ?? null,
      booksManagedBy: toStr(r.books_managed_by),
      enterpriseDefaults,
      brokenBankFeeds,
      onboardingIncomplete,
      toReview,
      toReviewOldestDays: daysSince(toStr(r.to_review_oldest)),
      depositsToReview,
      aiToVerify,
      uncategorizedToReview,
      reconOff,
      openFindings,
      overdueBills,
      overdueInvoices,
      openTasks,
      pendingMeetingFollowups,
      aiHandledThisWeek: toInt(r.ai_handled_week),
      lastActivityAt: lastIso ? new Date(lastIso) : null,
      blockingCount,
      needsAttentionCount,
      timelineSteps,
    };
  });

  clients.sort((a, b) => {
    if (a.blockingCount !== b.blockingCount) return b.blockingCount - a.blockingCount;
    if (a.needsAttentionCount !== b.needsAttentionCount) return b.needsAttentionCount - a.needsAttentionCount;
    return b.toReview - a.toReview;
  });

  const totals = {
    needsReview: clients.reduce((s, c) => s + c.toReview, 0),
    clientsWithIssues: clients.filter((c) => c.needsAttentionCount > 0).length,
    aiHandledThisWeek: clients.reduce((s, c) => s + c.aiHandledThisWeek, 0),
    waitingOnClient: clients.filter((c) => c.onboardingIncomplete).length,
  };

  return { clients, totals };
}
