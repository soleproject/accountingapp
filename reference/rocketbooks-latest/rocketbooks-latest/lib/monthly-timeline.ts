import 'server-only';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  accountingPeriods,
  aiClientOutreach,
  bills,
  bookReviewFindings,
  inboxMessages,
  invoices,
  receipts,
  reconciliationPeriods,
  transactions,
} from '@/db/schema/schema';

/**
 * The monthly bookkeeping timeline — a visual "state of the close" for one org,
 * for one calendar month. Every signal here already drives an existing surface
 * (action cards / firm client-health); this module just re-shapes the same
 * predicates into an ordered list of milestones for the timeline UI.
 *
 * Keep the predicates in sync with lib/server/action-cards.ts and
 * lib/enterprise/client-health.ts — they answer the same questions.
 *
 * Two groups:
 *   - 'close'    — the sequential steps needed to close the month
 *                  (categorize → reconcile → review → close).
 *   - 'activity' — things that happened during the month alongside the close
 *                  (client requests, communications, AP, AR).
 */

export type MilestoneStatus = 'done' | 'in_progress' | 'not_started' | 'waiting';
export type MilestoneGroup = 'close' | 'activity';

export interface MilestoneStep {
  id: string;
  group: MilestoneGroup;
  label: string;
  status: MilestoneStatus;
  /** Headline count for the node (0 when nothing outstanding). */
  count: number;
  /** Short human detail line, e.g. "off by $240" or "waiting on client". */
  detail?: string;
  /** Where the node links to so the user can go do the work. */
  href: string;
}

export interface MonthlyTimeline {
  period: { label: string; year: number; month: number };
  steps: MilestoneStep[];
}

/** Raw, pre-computed signal bag — the only input the mapper needs. */
export interface TimelineSignals {
  // ── close ──
  toReview: number;            // transactions awaiting review, dated this month
  reconOff: number;            // OPEN recon periods with a non-zero difference
  reconciledThisMonth: number; // RECONCILED recon periods overlapping this month
  openFindings: number;        // open book-review findings (current state)
  closeStatus: 'none' | 'open' | 'reviewed' | 'closed'; // accounting_periods
  // ── activity ──
  openOutreach: number;        // ai_client_outreach not yet resolved
  awaitingClient: number;      // subset of openOutreach awaiting a client reply
  pendingReceipts: number;     // receipts captured but not yet posted
  openThreads: number;         // inbox messages still open
  overdueBills: number;
  overdueInvoices: number;
}

export interface TimelineLinks {
  /** Client-requests node target ("/inbox" single-org, firm comms otherwise). */
  requestsHref?: string;
  /** Communications node target. */
  communicationsHref?: string;
}

function money(n: number): string {
  return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}

function plural(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? one + 's');
}

/**
 * Pure mapper: signals → ordered milestone list. This is the single source of
 * truth for step order, labels, status, and deep-links. No I/O.
 */
export function buildTimelineSteps(s: TimelineSignals, links: TimelineLinks = {}): MilestoneStep[] {
  const requestsHref = links.requestsHref ?? '/inbox';
  const communicationsHref = links.communicationsHref ?? '/inbox';

  // ── Reconcile: "off" rows beat everything; otherwise done only if something
  // actually reconciled this month — zero off-rows with nothing reconciled
  // means the work hasn't started, not that it's finished. ──
  let reconStatus: MilestoneStatus;
  let reconDetail: string | undefined;
  if (s.reconOff > 0) {
    reconStatus = 'in_progress';
    reconDetail =
      s.reconOff === 1 ? 'an account is off' : `${s.reconOff} accounts off`;
  } else if (s.reconciledThisMonth > 0) {
    reconStatus = 'done';
    reconDetail = `${s.reconciledThisMonth} ${plural(s.reconciledThisMonth, 'account')} reconciled`;
  } else {
    reconStatus = 'not_started';
    reconDetail = 'not started';
  }

  const closeStatus: MilestoneStatus =
    s.closeStatus === 'closed' ? 'done' : s.closeStatus === 'reviewed' ? 'in_progress' : 'not_started';
  const closeDetail =
    s.closeStatus === 'closed' ? 'closed' : s.closeStatus === 'reviewed' ? 'reviewed — ready to close' : 'open';

  const requestsStatus: MilestoneStatus =
    s.awaitingClient > 0 ? 'waiting' : s.openOutreach > 0 ? 'in_progress' : 'done';
  const requestsParts: string[] = [];
  if (s.awaitingClient > 0) requestsParts.push(`${s.awaitingClient} awaiting client`);
  else if (s.openOutreach > 0) requestsParts.push(`${s.openOutreach} open`);
  if (s.pendingReceipts > 0) requestsParts.push(`${s.pendingReceipts} ${plural(s.pendingReceipts, 'receipt')} to process`);

  return [
    {
      id: 'categorize',
      group: 'close',
      label: 'Categorize transactions',
      status: s.toReview > 0 ? 'in_progress' : 'done',
      count: s.toReview,
      detail: s.toReview > 0 ? `${s.toReview} to review` : 'all caught up',
      href: '/transactions?filter=to_review&guide=1',
    },
    {
      id: 'reconcile',
      group: 'close',
      label: 'Reconcile accounts',
      status: reconStatus,
      count: s.reconOff,
      detail: reconDetail,
      href: '/reconciliation',
    },
    {
      id: 'review',
      group: 'close',
      label: 'Review the books',
      status: s.openFindings > 0 ? 'in_progress' : 'done',
      count: s.openFindings,
      detail: s.openFindings > 0 ? `${s.openFindings} ${plural(s.openFindings, 'finding')} to clear` : 'no open findings',
      href: '/book-review',
    },
    {
      id: 'close',
      group: 'close',
      label: 'Close the month',
      status: closeStatus,
      count: 0,
      detail: closeDetail,
      href: '/period-close',
    },
    {
      id: 'requests',
      group: 'activity',
      label: 'Client requests',
      status: requestsStatus,
      count: s.awaitingClient || s.openOutreach,
      detail: requestsParts.length ? requestsParts.join(' · ') : 'nothing outstanding',
      href: requestsHref,
    },
    {
      id: 'communications',
      group: 'activity',
      label: 'Communications',
      status: s.openThreads > 0 ? 'waiting' : 'done',
      count: s.openThreads,
      detail: s.openThreads > 0 ? `${s.openThreads} ${plural(s.openThreads, 'thread')} awaiting reply` : 'inbox clear',
      href: communicationsHref,
    },
    {
      id: 'bills',
      group: 'activity',
      label: 'Bills (AP)',
      status: s.overdueBills > 0 ? 'in_progress' : 'done',
      count: s.overdueBills,
      detail: s.overdueBills > 0 ? `${s.overdueBills} overdue` : 'none overdue',
      href: '/bills',
    },
    {
      id: 'invoices',
      group: 'activity',
      label: 'Invoices (AR)',
      status: s.overdueInvoices > 0 ? 'in_progress' : 'done',
      count: s.overdueInvoices,
      detail: s.overdueInvoices > 0 ? `${s.overdueInvoices} overdue` : 'none overdue',
      href: '/invoices/follow-up',
    },
  ];
}

/**
 * Build the monthly timeline for one org. Pure data-fetching — no auth.
 * Mirrors the predicates in action-cards.ts so the numbers agree across surfaces.
 */
export async function getOrgMonthlyTimeline(orgId: string, links: TimelineLinks = {}): Promise<MonthlyTimeline> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const from = fmt(new Date(Date.UTC(y, m, 1)));
  const to = fmt(new Date(Date.UTC(y, m + 1, 0)));
  const toExclusive = fmt(new Date(Date.UTC(y, m + 1, 1)));
  const today = fmt(now);
  const label = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const [
    toReviewAgg,
    reconOffAgg,
    reconciledAgg,
    findingsAgg,
    [closeRow],
    outreachAgg,
    receiptsAgg,
    threadsAgg,
    overdueBillsAgg,
    overdueInvoicesAgg,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, orgId),
          sql`${transactions.reviewed} IS NOT TRUE`,
          sql`${transactions.date} >= ${from} AND ${transactions.date} < ${toExclusive}`,
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reconciliationPeriods)
      .where(
        and(
          eq(reconciliationPeriods.organizationId, orgId),
          eq(reconciliationPeriods.status, 'OPEN'),
          sql`${reconciliationPeriods.difference} IS NOT NULL AND ${reconciliationPeriods.difference} <> 0`,
          sql`${reconciliationPeriods.startDate} <= ${to} AND ${reconciliationPeriods.endDate} >= ${from}`,
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reconciliationPeriods)
      .where(
        and(
          eq(reconciliationPeriods.organizationId, orgId),
          eq(reconciliationPeriods.status, 'RECONCILED'),
          sql`${reconciliationPeriods.startDate} <= ${to} AND ${reconciliationPeriods.endDate} >= ${from}`,
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookReviewFindings)
      .where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'))),

    db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.organizationId, orgId),
          eq(accountingPeriods.year, y),
          eq(accountingPeriods.month, m + 1),
        ),
      )
      .limit(1),

    db
      .select({
        n: sql<number>`count(*)::int`,
        awaiting: sql<number>`count(*) filter (where ${aiClientOutreach.status} = 'awaiting_response')::int`,
      })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          sql`${aiClientOutreach.status} IN ('drafted', 'sent', 'awaiting_response')`,
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.organizationId, orgId), eq(receipts.posted, false))),

    db
      .select({ n: sql<number>`count(distinct coalesce(${inboxMessages.threadId}, ${inboxMessages.id}))::int` })
      .from(inboxMessages)
      .where(and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.status, 'open'))),

    db
      .select({ n: sql<number>`count(distinct ${bills.id})::int` })
      .from(bills)
      .where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted'), lt(bills.dueDate, today))),

    db
      .select({ n: sql<number>`count(distinct ${invoices.id})::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, orgId),
          ne(invoices.status, 'paid'),
          eq(invoices.posted, true),
          lt(invoices.dueDate, today),
        ),
      ),
  ]);

  const closeStatusRaw = closeRow?.status as 'open' | 'reviewed' | 'closed' | undefined;

  const signals: TimelineSignals = {
    toReview: toReviewAgg[0]?.n ?? 0,
    reconOff: reconOffAgg[0]?.n ?? 0,
    reconciledThisMonth: reconciledAgg[0]?.n ?? 0,
    openFindings: findingsAgg[0]?.n ?? 0,
    closeStatus: closeStatusRaw ?? 'none',
    openOutreach: outreachAgg[0]?.n ?? 0,
    awaitingClient: outreachAgg[0]?.awaiting ?? 0,
    pendingReceipts: receiptsAgg[0]?.n ?? 0,
    openThreads: threadsAgg[0]?.n ?? 0,
    overdueBills: overdueBillsAgg[0]?.n ?? 0,
    overdueInvoices: overdueInvoicesAgg[0]?.n ?? 0,
  };

  return {
    period: { label, year: y, month: m + 1 },
    steps: buildTimelineSteps(signals, links),
  };
}

/**
 * One monthly timeline per month that has transaction data, most-recent first.
 * Month-scoped signals (categorize/reconcile/close/AP/AR) are computed per
 * month via grouped queries; inherently current-state signals (open findings,
 * outreach, threads, receipts) apply only to the current month (0 for past
 * months, where the close work is presumed done). A handful of grouped queries
 * total — not N×per-month.
 */
export async function getOrgMonthlyTimelineHistory(
  orgId: string,
  links: TimelineLinks = {},
): Promise<MonthlyTimeline[]> {
  const now = new Date();
  const curYM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [
    months,
    toReviewRows,
    reconRows,
    closeRows,
    billRows,
    invoiceRows,
    findingsAgg,
    outreachAgg,
    threadsAgg,
    receiptsAgg,
  ] = await Promise.all([
    db
      .select({ m: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`.as('m') })
      .from(transactions)
      .where(eq(transactions.organizationId, orgId))
      .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`),
    db
      .select({ m: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`.as('m'), n: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), sql`${transactions.reviewed} IS NOT TRUE`))
      .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`),
    db
      .select({
        m: sql<string>`to_char(${reconciliationPeriods.startDate}, 'YYYY-MM')`.as('m'),
        off: sql<number>`(count(*) filter (where ${reconciliationPeriods.status} = 'OPEN' and ${reconciliationPeriods.difference} is not null and ${reconciliationPeriods.difference} <> 0))::int`,
        done: sql<number>`(count(*) filter (where ${reconciliationPeriods.status} = 'RECONCILED'))::int`,
      })
      .from(reconciliationPeriods)
      .where(eq(reconciliationPeriods.organizationId, orgId))
      .groupBy(sql`to_char(${reconciliationPeriods.startDate}, 'YYYY-MM')`),
    db
      .select({ year: accountingPeriods.year, month: accountingPeriods.month, status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(eq(accountingPeriods.organizationId, orgId)),
    db
      .select({ m: sql<string>`to_char(${bills.dueDate}, 'YYYY-MM')`.as('m'), n: sql<number>`count(distinct ${bills.id})::int` })
      .from(bills)
      .where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted')))
      .groupBy(sql`to_char(${bills.dueDate}, 'YYYY-MM')`),
    db
      .select({ m: sql<string>`to_char(${invoices.dueDate}, 'YYYY-MM')`.as('m'), n: sql<number>`count(distinct ${invoices.id})::int` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, orgId), ne(invoices.status, 'paid'), eq(invoices.posted, true)))
      .groupBy(sql`to_char(${invoices.dueDate}, 'YYYY-MM')`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookReviewFindings)
      .where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'))),
    db
      .select({
        n: sql<number>`count(*)::int`,
        awaiting: sql<number>`(count(*) filter (where ${aiClientOutreach.status} = 'awaiting_response'))::int`,
      })
      .from(aiClientOutreach)
      .where(and(eq(aiClientOutreach.organizationId, orgId), sql`${aiClientOutreach.status} IN ('drafted', 'sent', 'awaiting_response')`)),
    db
      .select({ n: sql<number>`count(distinct coalesce(${inboxMessages.threadId}, ${inboxMessages.id}))::int` })
      .from(inboxMessages)
      .where(and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.status, 'open'))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.organizationId, orgId), eq(receipts.posted, false))),
  ]);

  const toReviewByM = new Map(toReviewRows.map((r) => [r.m, Number(r.n)]));
  const reconByM = new Map(reconRows.map((r) => [r.m, { off: Number(r.off), done: Number(r.done) }]));
  const closeByM = new Map(closeRows.map((r) => [`${r.year}-${String(r.month).padStart(2, '0')}`, r.status]));
  const billsByM = new Map(billRows.map((r) => [r.m, Number(r.n)]));
  const invByM = new Map(invoiceRows.map((r) => [r.m, Number(r.n)]));
  const curFindings = findingsAgg[0]?.n ?? 0;
  const curOutreach = outreachAgg[0]?.n ?? 0;
  const curAwaiting = outreachAgg[0]?.awaiting ?? 0;
  const curThreads = threadsAgg[0]?.n ?? 0;
  const curReceipts = receiptsAgg[0]?.n ?? 0;

  const monthKeys = months
    .map((r) => r.m)
    .filter((m): m is string => !!m)
    .sort()
    .reverse(); // most recent first

  return monthKeys.map((mk) => {
    const [y, mo] = mk.split('-').map(Number);
    const isCurrent = mk === curYM;
    const recon = reconByM.get(mk) ?? { off: 0, done: 0 };
    const closeRaw = closeByM.get(mk);
    const steps = buildTimelineSteps(
      {
        toReview: toReviewByM.get(mk) ?? 0,
        reconOff: recon.off,
        reconciledThisMonth: recon.done,
        openFindings: isCurrent ? curFindings : 0,
        closeStatus: closeRaw === 'closed' || closeRaw === 'reviewed' || closeRaw === 'open' ? closeRaw : 'none',
        openOutreach: isCurrent ? curOutreach : 0,
        awaitingClient: isCurrent ? curAwaiting : 0,
        pendingReceipts: isCurrent ? curReceipts : 0,
        openThreads: isCurrent ? curThreads : 0,
        overdueBills: billsByM.get(mk) ?? 0,
        overdueInvoices: invByM.get(mk) ?? 0,
      },
      links,
    );
    const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return { period: { label, year: y, month: mo }, steps };
  });
}
