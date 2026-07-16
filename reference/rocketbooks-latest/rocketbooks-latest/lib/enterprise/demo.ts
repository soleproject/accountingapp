import type { EnterpriseClientCounts } from './clients';
import type { ClientHealth, FirmHealth } from './client-health';
import { buildTimelineSteps, type MonthlyTimeline, type TimelineLinks } from '@/lib/monthly-timeline';
import type { OutreachIssueType } from './ai-actions';
import type { OutreachMap, OutreachRecord } from './outreach';

/**
 * Synthetic "Demo Enterprise" — a virtual enterprise (no DB rows) that renders
 * the dashboard with rich, hand-authored data so every capability is visible at
 * once: broken bank feeds, reconciliation off, overdue bills/invoices, meeting
 * debriefs, AI activity, and the full range of client statuses (Action needed /
 * Review / Setup / Current) plus the tier earnings panel.
 *
 * It's wired through the normal enterprise switcher (cookie = this id). The
 * dashboard short-circuits to this data when the active enterprise is the demo;
 * nothing here touches the database, and its actions are non-functional (the
 * client users are fictional).
 */
export const DEMO_ENTERPRISE_ID = '__demo_enterprise__';
export const DEMO_ENTERPRISE_NAME = 'Demo Enterprise';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

interface DemoSignals {
  orgName: string;
  ownerName: string;
  ownerEmail: string;
  brokenBankFeeds?: number;
  onboardingIncomplete?: boolean;
  toReview?: number;
  toReviewOldestDays?: number | null;
  reconOff?: number;
  overdueBills?: number;
  overdueInvoices?: number;
  openTasks?: number;
  pendingMeetingFollowups?: number;
  aiHandledThisWeek?: number;
  lastActivityDaysAgo?: number | null;
}

function buildClient(i: number, s: DemoSignals): ClientHealth {
  const brokenBankFeeds = s.brokenBankFeeds ?? 0;
  const onboardingIncomplete = s.onboardingIncomplete ?? false;
  const toReview = s.toReview ?? 0;
  const reconOff = s.reconOff ?? 0;
  const overdueBills = s.overdueBills ?? 0;
  const overdueInvoices = s.overdueInvoices ?? 0;
  const openTasks = s.openTasks ?? 0;
  const pendingMeetingFollowups = s.pendingMeetingFollowups ?? 0;

  // Same derivation as getEnterpriseClientHealth so demo + real behave identically.
  const blockingCount = brokenBankFeeds > 0 ? 1 : 0;
  const needsAttentionCount =
    brokenBankFeeds +
    reconOff +
    (overdueBills > 0 ? 1 : 0) +
    (overdueInvoices > 0 ? 1 : 0) +
    (toReview > 0 ? 1 : 0) +
    (openTasks > 0 ? 1 : 0) +
    (pendingMeetingFollowups > 0 ? 1 : 0);

  return {
    orgId: `demo-org-${i}`,
    orgName: s.orgName,
    ownerUserId: `demo-user-${i}`,
    ownerName: s.ownerName,
    ownerEmail: s.ownerEmail,
    ownerRole: null,
    taskResponsibilities: null,
    booksManagedBy: null,
    enterpriseDefaults: null,
    brokenBankFeeds,
    onboardingIncomplete,
    toReview,
    toReviewOldestDays: s.toReviewOldestDays ?? null,
    // Synthetic split of the demo's review count across the three sub-reviews.
    depositsToReview: Math.round(toReview * 0.3),
    aiToVerify: Math.round(toReview * 0.8),
    uncategorizedToReview: toReview - Math.round(toReview * 0.3),
    reconOff,
    openFindings: 0,
    overdueBills,
    overdueInvoices,
    openTasks,
    pendingMeetingFollowups,
    aiHandledThisWeek: s.aiHandledThisWeek ?? 0,
    lastActivityAt: s.lastActivityDaysAgo == null ? null : daysAgo(s.lastActivityDaysAgo),
    blockingCount,
    needsAttentionCount,
    timelineSteps: buildTimelineSteps(
      {
        toReview,
        reconOff,
        reconciledThisMonth: 0,
        openFindings: 0,
        closeStatus: 'none',
        openOutreach: 0,
        awaitingClient: 0,
        pendingReceipts: 0,
        openThreads: 0,
        overdueBills,
        overdueInvoices,
      },
      { requestsHref: '/enterprise/communications', communicationsHref: '/enterprise/communications' },
    ),
  };
}

const DEMO_SIGNALS: DemoSignals[] = [
  {
    orgName: 'Apex Logistics Inc',
    ownerName: 'Dana Reyes',
    ownerEmail: 'dana@apexlogistics.com',
    brokenBankFeeds: 2,
    toReview: 88,
    toReviewOldestDays: 19,
    reconOff: 2,
    overdueBills: 2,
    overdueInvoices: 1,
    openTasks: 3,
    pendingMeetingFollowups: 1,
    aiHandledThisWeek: 150,
    lastActivityDaysAgo: 1,
  },
  {
    orgName: 'Riverside Dental, PLLC',
    ownerName: 'Dr. Priya Nair',
    ownerEmail: 'priya@riversidedental.com',
    brokenBankFeeds: 1,
    toReview: 47,
    toReviewOldestDays: 31,
    aiHandledThisWeek: 120,
    lastActivityDaysAgo: 2,
  },
  {
    orgName: 'Greenfield Landscaping',
    ownerName: 'Marcus Webb',
    ownerEmail: 'marcus@greenfieldscapes.com',
    toReview: 230,
    toReviewOldestDays: 64,
    openTasks: 2,
    aiHandledThisWeek: 310,
    lastActivityDaysAgo: 3,
  },
  {
    orgName: 'Summit Builders LLC',
    ownerName: 'Elena Sokolova',
    ownerEmail: 'elena@summitbuilders.com',
    reconOff: 1,
    overdueBills: 3,
    toReview: 12,
    toReviewOldestDays: 8,
    aiHandledThisWeek: 85,
    lastActivityDaysAgo: 1,
  },
  {
    orgName: 'Harborview Cafe',
    ownerName: 'Tom Becker',
    ownerEmail: 'tom@harborviewcafe.com',
    overdueInvoices: 5,
    openTasks: 4,
    aiHandledThisWeek: 20,
    lastActivityDaysAgo: 5,
  },
  {
    orgName: 'Meridian Law Group',
    ownerName: 'Aisha Rahman',
    ownerEmail: 'aisha@meridianlaw.com',
    pendingMeetingFollowups: 2,
    openTasks: 6,
    aiHandledThisWeek: 40,
    lastActivityDaysAgo: 4,
  },
  {
    orgName: 'Nova Fitness Studio',
    ownerName: 'Chris Tanaka',
    ownerEmail: 'chris@novafitness.com',
    onboardingIncomplete: true,
    lastActivityDaysAgo: 12,
  },
  {
    orgName: 'Lakeside Properties LLC',
    ownerName: 'Grace Oduya',
    ownerEmail: 'grace@lakesideproperties.com',
    aiHandledThisWeek: 60,
    lastActivityDaysAgo: 1,
  },
];

/** Rich synthetic FirmHealth, sorted worst-first like the real query. */
export function getDemoFirmHealth(): FirmHealth {
  const clients = DEMO_SIGNALS.map((s, i) => buildClient(i + 1, s));
  clients.sort((a, b) => {
    if (a.blockingCount !== b.blockingCount) return b.blockingCount - a.blockingCount;
    if (a.needsAttentionCount !== b.needsAttentionCount) return b.needsAttentionCount - a.needsAttentionCount;
    return b.toReview - a.toReview;
  });
  return {
    clients,
    totals: {
      needsReview: clients.reduce((s, c) => s + c.toReview, 0),
      clientsWithIssues: clients.filter((c) => c.needsAttentionCount > 0).length,
      aiHandledThisWeek: clients.reduce((s, c) => s + c.aiHandledThisWeek, 0),
      waitingOnClient: clients.filter((c) => c.onboardingIncomplete).length,
    },
  };
}

// Months of synthetic bookkeeping history per DEMO_SIGNALS index. Apex (0) has
// a full 24; Nova Fitness (6) is mid-onboarding so has none; the rest vary.
const DEMO_MONTH_COUNTS = [24, 18, 15, 12, 9, 20, 0, 6];

/** Deterministic 0..1 pseudo-random so the demo history is stable across renders. */
function seeded(idx: number, k: number, salt: number): number {
  const x = Math.sin(idx * 12.9898 + k * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

/** Build N months of plausible, deterministic timelines for a demo client. */
function demoMonthlyHistory(idx: number, links: TimelineLinks): MonthlyTimeline[] {
  const count = DEMO_MONTH_COUNTS[idx] ?? 0;
  const now = new Date();
  const out: MonthlyTimeline[] = [];
  for (let k = 0; k < count; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    const closed = k >= 2; // months older than ~2 are wrapped up
    const closeStatus: 'open' | 'reviewed' | 'closed' = closed ? 'closed' : k === 1 ? 'reviewed' : 'open';
    const steps = buildTimelineSteps(
      {
        toReview: closed ? 0 : Math.round(seeded(idx, k, 1) * 35) + (k === 0 ? 8 : 2),
        reconOff: closed ? 0 : seeded(idx, k, 2) > 0.65 ? Math.round(seeded(idx, k, 3) * 3) + 1 : 0,
        reconciledThisMonth: closed ? 1 + Math.round(seeded(idx, k, 4) * 2) : seeded(idx, k, 5) > 0.5 ? 1 : 0,
        openFindings: closed ? 0 : Math.round(seeded(idx, k, 6) * 12),
        closeStatus,
        openOutreach: closed ? 0 : Math.round(seeded(idx, k, 7) * 2),
        awaitingClient: 0,
        pendingReceipts: closed ? 0 : Math.round(seeded(idx, k, 8) * 3),
        openThreads: 0,
        overdueBills: closed ? 0 : Math.round(seeded(idx, k, 9) * 2),
        overdueInvoices: closed ? 0 : Math.round(seeded(idx, k, 10) * 2),
      },
      links,
    );
    out.push({
      period: {
        label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
      },
      steps,
    });
  }
  return out;
}

/**
 * Detail payload for a demo client detail page (id like "demo-user-3"). Demo
 * clients aren't real DB users, so the detail route renders this instead of 404.
 */
export interface DemoComm {
  at: Date | null;
  issueType: string;
  channel: string | null;
  body: string;
  status: string;
}

export function getDemoClientDetail(id: string):
  | {
      orgName: string;
      ownerName: string;
      ownerEmail: string;
      history: MonthlyTimeline[];
      health: ClientHealth;
      outreach: OutreachMap;
      comms: DemoComm[];
    }
  | null {
  const m = /^demo-user-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  const s = DEMO_SIGNALS[n - 1];
  if (!s) return null;

  const health = buildClient(n, s);
  const outreach = getDemoOutreachMap();
  const orgId = `demo-org-${n}`;
  const comms: DemoComm[] = [];
  for (const [key, rec] of outreach) {
    if (!key.startsWith(`${orgId}:`) || !rec.lastMessageBody) continue;
    comms.push({
      at: rec.lastContactAt,
      issueType: rec.issueType as string,
      channel: rec.channel,
      body: rec.lastMessageBody,
      status: rec.status as string,
    });
  }
  comms.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

  return {
    orgName: s.orgName,
    ownerName: s.ownerName,
    ownerEmail: s.ownerEmail,
    history: demoMonthlyHistory(n - 1, {
      requestsHref: '/enterprise/communications',
      communicationsHref: '/enterprise/communications',
    }),
    health,
    outreach,
    comms,
  };
}

export interface DemoClientRow {
  userId: string;
  fullName: string;
  email: string;
  status: string;
  isActive: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

/** Synthetic client-user rows for the demo enterprise's Clients page. */
export function getDemoEnterpriseClients(): DemoClientRow[] {
  return DEMO_SIGNALS.map((s, i) => ({
    userId: `demo-user-${i + 1}`,
    fullName: s.ownerName,
    email: s.ownerEmail,
    status: 'active',
    isActive: true,
    createdAt: daysAgo((i + 1) * 6).toISOString(),
    lastSignInAt: s.onboardingIncomplete ? null : daysAgo(s.lastActivityDaysAgo ?? 1).toISOString(),
  }));
}

/**
 * Synthetic AI-outreach state per (demo org, issue) so the queue's AI columns
 * (action / last contact / last message) show a realistic mix of statuses:
 * sent, awaiting response, and drafts ready for review.
 */
export function getDemoOutreachMap(): OutreachMap {
  const m: OutreachMap = new Map();
  const add = (
    orgId: string,
    issueType: OutreachIssueType,
    rec: Omit<OutreachRecord, 'organizationId' | 'issueType'>,
  ) => m.set(`${orgId}:${issueType}`, { organizationId: orgId, issueType, ...rec });

  // Apex Logistics (demo-org-1)
  add('demo-org-1', 'broken_bank', { status: 'sent', channel: 'sms', lastContactAt: daysAgo(1), lastMessageBody: 'Hi Dana — your Chase and Amex feeds disconnected, so new transactions aren’t importing. Could you reconnect them in RocketBooks? Takes about a minute.' });
  add('demo-org-1', 'overdue_invoices', { status: 'awaiting_response', channel: 'email', lastContactAt: daysAgo(2), lastMessageBody: 'Hi Dana — a few of your customer invoices are past due. Want us to send friendly payment reminders to those customers on your behalf?' });
  add('demo-org-1', 'to_review', { status: 'drafted', channel: 'email', lastContactAt: null, lastMessageBody: 'Hi Dana, 88 transactions are ready for a quick review so we can close out the month — want me to walk you through them?' });
  // Riverside Dental (demo-org-2)
  add('demo-org-2', 'broken_bank', { status: 'awaiting_response', channel: 'sms', lastContactAt: daysAgo(3), lastMessageBody: 'Hi Priya, your bank feed dropped — please reconnect when you get a sec so we keep your books current.' });
  // Greenfield Landscaping (demo-org-3)
  add('demo-org-3', 'to_review', { status: 'sent', channel: 'email', lastContactAt: daysAgo(4), lastMessageBody: 'Hi Marcus, 230 transactions are waiting on your review. They go fast once you start — I can hop on a call if that’s easier.' });
  // Summit Builders (demo-org-4)
  add('demo-org-4', 'overdue_bills', { status: 'sent', channel: 'email', lastContactAt: daysAgo(1), lastMessageBody: 'Hi Elena, you have 3 bills coming due — want me to line them up for payment?' });
  // Harborview Cafe (demo-org-5)
  add('demo-org-5', 'overdue_invoices', { status: 'drafted', channel: 'email', lastContactAt: null, lastMessageBody: 'Hi Tom — 5 customer invoices are overdue. Would you like us to nudge those customers for you?' });
  // Meridian Law (demo-org-6)
  add('demo-org-6', 'meeting_followup', { status: 'sent', channel: 'email', lastContactAt: daysAgo(2), lastMessageBody: 'Hi Aisha, following up on our recent meeting — could you send over the notes and any items we discussed?' });

  return m;
}

/** Subscription mix for the tier earnings panel + Total Clients KPI. */
export const DEMO_COUNTS: EnterpriseClientCounts = {
  paying: 6,
  trial: 1,
  none: 1,
  source: { inviteLink: 5, manual: 2, unknown: 1 },
  total: 8,
};

/** Org row shape consumed by the dashboard (name/domain/plan/tier/createdAt). */
export const DEMO_ORG = {
  name: DEMO_ENTERPRISE_NAME,
  domain: 'demo-firm.example.com',
  planType: 'enterprise' as const,
  tier: null as string | null, // Regular enterprise — no paid tier / platform fee
  createdAt: new Date(Date.now() - 420 * DAY).toISOString(),
};

/** Recent-activity feed entries (shape matches the dashboard's adminAuditLog select). */
export const DEMO_ACTIVITY = [
  { id: 'demo-act-1', action: 'client.onboarded', targetType: 'organization', timestamp: daysAgo(1).toISOString(), adminEmail: 'you@demo-firm.example.com' },
  { id: 'demo-act-2', action: 'transactions.categorized', targetType: 'organization', timestamp: daysAgo(1).toISOString(), adminEmail: 'ai@rocketbooks' },
  { id: 'demo-act-3', action: 'reconciliation.completed', targetType: 'organization', timestamp: daysAgo(2).toISOString(), adminEmail: 'you@demo-firm.example.com' },
  { id: 'demo-act-4', action: 'staff.invited', targetType: 'enterprise', timestamp: daysAgo(6).toISOString(), adminEmail: 'you@demo-firm.example.com' },
];
