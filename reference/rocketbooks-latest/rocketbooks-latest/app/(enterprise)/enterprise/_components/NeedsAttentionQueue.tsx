import type { ClientHealth } from '@/lib/enterprise/client-health';
import type { OutreachMap } from '@/lib/enterprise/outreach';
import { outreachKey } from '@/lib/enterprise/outreach';
import { AI_ACTION_TAXONOMY, outreachStatusLabel, type OutreachIssueType, type OutreachStatus } from '@/lib/enterprise/ai-actions';
import { SIGNAL_TO_TASK_KEY, SIGNAL_COVERED_TASK_KEYS, TASK_CATALOG, resolveEffectiveOwner, parseResponsibilities } from '@/lib/enterprise/task-catalog';
import { cache } from 'react';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks } from '@/db/schema/schema';
import { QueueTable, type QueueRowData } from './QueueTable';

export type AttentionAudience = 'all' | 'pro' | 'ai' | 'client';

/**
 * Who owns the next move on an issue — partitions the queue into the
 * Pro/AI/Client attention tabs:
 *  - pro: bookkeeper-only work (reconciliation, internal tasks, meeting debriefs)
 *  - client: AI already reached out and is awaiting the client's reply
 *  - ai: client-facing issue the AI hasn't acted on yet (ready to draft/send)
 */
function rowAudience(issueType: OutreachIssueType | undefined, status: OutreachStatus | undefined): 'pro' | 'ai' | 'client' {
  // Bookkeeper-owned issues (reconciliation, meeting debrief) + rows with no
  // issue type (internal tasks) are pro work — driven by the taxonomy `owner`.
  if (!issueType || AI_ACTION_TAXONOMY[issueType].owner === 'pro') return 'pro';
  if (status === 'sent' || status === 'awaiting_response' || status === 'resolved') return 'client';
  return 'ai';
}

/**
 * Audience for a row. When the signal maps to a responsibility-matrix task, the
 * company's chosen owner wins (pro → Pro tab). Client-owned signals still split
 * AI (a draftable outreach not yet sent) vs Client (awaiting reply, or no AI
 * outreach to send). Unmapped signals fall back to the taxonomy default.
 */
function audienceFor(
  r: QueueRow,
  status: OutreachStatus | undefined,
  client: ClientHealth | undefined,
): 'pro' | 'ai' | 'client' {
  // Forced client-owned (Deposits + Uncategorized reviews always need the client,
  // whatever the radial says) → never Pro; split AI (drafted nudge) vs Client.
  if (r.forceClientOwned) {
    const def = r.issueType ? AI_ACTION_TAXONOMY[r.issueType] : undefined;
    const canDraft = !!def && def.actionMode !== 'route';
    if (!canDraft) return 'client';
    return status === 'sent' || status === 'awaiting_response' || status === 'resolved' ? 'client' : 'ai';
  }
  const taskKey = r.issueType ? SIGNAL_TO_TASK_KEY[r.issueType] : undefined;
  const task = taskKey ? TASK_CATALOG.find((t) => t.key === taskKey) : undefined;
  if (task && client) {
    const booksManagedBy =
      client.booksManagedBy === 'firm' || client.booksManagedBy === 'client' ? client.booksManagedBy : null;
    // client override → enterprise default → catalog smart default.
    const owner = resolveEffectiveOwner(
      task,
      parseResponsibilities(client.taskResponsibilities),
      parseResponsibilities(client.enterpriseDefaults),
      booksManagedBy,
    );
    if (owner === 'pro') return 'pro';
    // Client-owned: AI drafts the nudge when one exists and hasn't been sent yet.
    const def = r.issueType ? AI_ACTION_TAXONOMY[r.issueType] : undefined;
    const canDraft = !!def && def.actionMode !== 'route';
    if (!canDraft) return 'client';
    return status === 'sent' || status === 'awaiting_response' || status === 'resolved' ? 'client' : 'ai';
  }
  return rowAudience(r.issueType, status);
}

/**
 * The firm's cross-client work queue: every actionable signal from every
 * client, flattened and sorted worst-first, then audience-filtered for the
 * active tab. This server component does the data prep; QueueTable renders the
 * interactive table (selection + bulk outreach).
 */

interface QueueRow {
  key: string;
  orgId: string;
  ownerUserId: string;
  ownerIsSuper: boolean;
  clientName: string;
  severity: 'blocking' | 'normal';
  sortKey: number;
  title: string;
  detail?: string;
  issueType?: OutreachIssueType;
  aiDetail: string;
  next: string;
  /** Always client-owned regardless of the responsibility radial — Deposits +
   *  Uncategorized reviews need the client's input in every case. Skips the Pro tab. */
  forceClientOwned?: boolean;
}

const QUEUE_CAP = 50;

const EMPTY_MESSAGE: Record<AttentionAudience, string> = {
  all: '🎉 All clients are caught up — nothing needs your attention.',
  pro: '🎉 Nothing needs your hands-on attention right now.',
  ai: '🎉 The AI has no pending outreach to draft or send.',
  client: '🎉 Nothing is waiting on a client right now.',
};

function pluralize(n: number, s: string, p?: string): string {
  return n === 1 ? s : p ?? s + 's';
}

function rowsForClient(c: ClientHealth): QueueRow[] {
  const isSuper = c.ownerRole === 'super_admin' || c.ownerRole === 'superadmin';
  const base = { orgId: c.orgId, ownerUserId: c.ownerUserId, ownerIsSuper: isSuper, clientName: c.orgName };
  const rows: QueueRow[] = [];

  // Onboarding-incomplete is intentionally NOT a queue row — it's near-
  // universal for firm-managed clients and shows as the "Setup" status instead.
  if (c.brokenBankFeeds > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:bank`,
      severity: 'blocking',
      sortKey: 1,
      title: 'Reconnect bank feed',
      detail: `${c.brokenBankFeeds} ${pluralize(c.brokenBankFeeds, 'account')} need reconnecting`,
      issueType: 'broken_bank',
      aiDetail: `${c.brokenBankFeeds} bank ${pluralize(c.brokenBankFeeds, 'account')} disconnected`,
      next: '/',
    });
  }
  if (c.reconOff > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:recon`,
      severity: 'normal',
      sortKey: 101,
      title: c.reconOff === 1 ? 'Reconciliation off' : `Reconciliation off across ${c.reconOff} accounts`,
      issueType: 'recon_off',
      aiDetail: `reconciliation is off across ${c.reconOff} ${pluralize(c.reconOff, 'account')}`,
      next: '/reconciliation',
    });
  }
  // Book-review findings — a live signal (only shows when the audit sweep left open
  // findings), routed by the "Clear book-review findings" owner. The other party gets
  // nothing. The duplicate/integrity/anomaly breakdown lives on /book-review.
  if (c.openFindings > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:findings`,
      severity: 'normal',
      sortKey: 101,
      title: `Clear ${c.openFindings} book-review ${pluralize(c.openFindings, 'finding')}`,
      detail: 'Duplicates, integrity & anomaly checks from the audit sweep',
      issueType: 'findings_open',
      aiDetail: `${c.openFindings} book-review ${pluralize(c.openFindings, 'finding')} to clear`,
      next: '/book-review',
    });
  }
  if (c.overdueBills > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:bills`,
      severity: 'normal',
      sortKey: 101,
      title: `${c.overdueBills} ${pluralize(c.overdueBills, 'bill')} overdue`,
      issueType: 'overdue_bills',
      aiDetail: `${c.overdueBills} ${pluralize(c.overdueBills, 'bill')} past due`,
      next: '/bills',
    });
  }
  // "Categorize & review" fans out into three data-driven sub-reviews. Review AI
  // Categorized follows the responsibility radial (Pro when the firm owns it, via
  // the to_review→categorize_transactions mapping). Review Deposits + Uncategorized
  // always need the client's input, so they're forceClientOwned (Client/AI tabs)
  // regardless of the radial. Each links to its step in the /transactions stepper.
  if (c.aiToVerify > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:review_ai`,
      severity: 'normal',
      sortKey: 102,
      title: `Review ${c.aiToVerify > 99 ? '99+' : c.aiToVerify} AI-categorized ${pluralize(c.aiToVerify, 'transaction')}`,
      detail: 'Confirm the AI categorization is correct',
      issueType: 'to_review',
      aiDetail: `${c.aiToVerify} AI-categorized ${pluralize(c.aiToVerify, 'transaction')} awaiting verification`,
      next: '/transactions?filter=to_verify&deposits=1&withdrawals=1',
    });
  }
  if (c.depositsToReview > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:review_deposits`,
      severity: 'normal',
      sortKey: 102,
      title: `Review ${c.depositsToReview > 99 ? '99+' : c.depositsToReview} ${pluralize(c.depositsToReview, 'deposit')}`,
      detail: 'Deposits need the client to confirm what they are',
      issueType: 'to_review',
      forceClientOwned: true,
      aiDetail: `${c.depositsToReview} ${pluralize(c.depositsToReview, 'deposit')} to review`,
      next: '/transactions?deposits=1&withdrawals=0&reviewed=0&unreviewed=1&filter=to_review',
    });
  }
  if (c.uncategorizedToReview > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:review_uncat`,
      severity: 'normal',
      sortKey: 102,
      title: `Review ${c.uncategorizedToReview > 99 ? '99+' : c.uncategorizedToReview} uncategorized ${pluralize(c.uncategorizedToReview, 'transaction')}`,
      detail: "Uncategorized spending needs the client's input",
      issueType: 'to_review',
      forceClientOwned: true,
      aiDetail: `${c.uncategorizedToReview} uncategorized ${pluralize(c.uncategorizedToReview, 'transaction')} to review`,
      next: '/transactions?reviewed=0&unreviewed=1&deposits=0&withdrawals=1&filter=to_review',
    });
  }
  // (The Pro "Monthly overview" when the client owns the books is a real recurring
  // task now — generated in recurring-tasks.ts, surfaced via buildRecurringTaskRows
  // + /enterprise/work — not a data-driven row here.)
  if (c.overdueInvoices > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:invoices`,
      severity: 'normal',
      sortKey: 102,
      title: `${c.overdueInvoices} ${pluralize(c.overdueInvoices, 'invoice')} overdue`,
      issueType: 'overdue_invoices',
      aiDetail: `${c.overdueInvoices} ${pluralize(c.overdueInvoices, 'invoice')} unpaid by their customers`,
      next: '/invoices',
    });
  }
  if (c.openTasks > 0) {
    // Internal firm tasks — no client outreach, so no AI action on this row.
    rows.push({
      ...base,
      key: `${c.orgId}:tasks`,
      severity: 'normal',
      sortKey: 103,
      title: `${c.openTasks} open ${pluralize(c.openTasks, 'task')}`,
      aiDetail: `${c.openTasks} open ${pluralize(c.openTasks, 'task')}`,
      next: '/tasks',
    });
  }
  if (c.pendingMeetingFollowups > 0) {
    rows.push({
      ...base,
      key: `${c.orgId}:followups`,
      severity: 'normal',
      sortKey: 103,
      title: `${c.pendingMeetingFollowups} ${pluralize(c.pendingMeetingFollowups, 'meeting')} to debrief`,
      issueType: 'meeting_followup',
      aiDetail: `${c.pendingMeetingFollowups} ${pluralize(c.pendingMeetingFollowups, 'meeting')} awaiting debrief`,
      next: '/organizer/meetings',
    });
  }

  return rows;
}

interface DueTaskRow {
  id: string;
  organizationId: string | null;
  title: string;
  dueDate: string | null;
  entityId: string | null;
}

// Open recurring tasks due within the window (or overdue) for the firm's
// clients. Cached so the 4 attention tabs share one query per request.
const getDueSoonRecurringTasks = cache(async (orgIdsKey: string): Promise<DueTaskRow[]> => {
  if (!orgIdsKey) return [];
  const orgIds = orgIdsKey.split(',');
  const cutoff = new Date(Date.now() + 21 * 86_400_000).toISOString();
  return db
    .select({
      id: tasks.id,
      organizationId: tasks.organizationId,
      title: tasks.title,
      dueDate: tasks.dueDate,
      entityId: tasks.entityId,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.organizationId, orgIds),
        eq(tasks.source, 'recurring'),
        eq(tasks.status, 'OPEN'),
        lte(tasks.dueDate, cutoff),
      ),
    )
    .limit(300);
});

// Build matrix-routed, due-date-gated attention rows from scheduled recurring
// tasks. The stored category is ignored — we re-resolve the current owner
// (client override → enterprise default → smart) so a responsibility change
// re-routes immediately.
async function buildRecurringTaskRows(
  clients: ClientHealth[],
  clientByOrg: Map<string, ClientHealth>,
): Promise<Array<{ r: QueueRow; rec: undefined; audience: 'pro' | 'client' }>> {
  const orgIdsKey = [...clients.map((c) => c.orgId)].sort().join(',');
  const dueTasks = await getDueSoonRecurringTasks(orgIdsKey);
  const now = Date.now();
  const out: Array<{ r: QueueRow; rec: undefined; audience: 'pro' | 'client' }> = [];
  for (const t of dueTasks) {
    const client = t.organizationId ? clientByOrg.get(t.organizationId) : undefined;
    if (!client || !t.organizationId) continue;
    const key = (t.entityId ?? '').split(':')[0];
    // Synthetic firm "monthly overview" task (generated when the client owns
    // categorize) — not a catalog row; always pro oversight, links to the client's
    // AI-categorized view.
    if (key === 'categorize_overview') {
      const due = t.dueDate ? new Date(t.dueDate) : null;
      const overdue = due ? due.getTime() < now : false;
      out.push({
        r: {
          key: `rtask:${t.id}`,
          orgId: t.organizationId,
          ownerUserId: client.ownerUserId,
          ownerIsSuper: false,
          clientName: client.orgName,
          severity: overdue ? 'blocking' : 'normal',
          sortKey: overdue ? 90 : 103,
          title: t.title,
          detail: due ? `Due ${due.toLocaleDateString()}${overdue ? ' · overdue' : ''}` : undefined,
          issueType: undefined,
          aiDetail: t.title,
          next: '/transactions?filter=to_verify&deposits=1&withdrawals=1',
        },
        rec: undefined,
        audience: 'pro',
      });
      continue;
    }
    // Signal-covered keys (e.g. book_review_findings) render as LIVE signals now, not
    // scheduled recurring rows — skip any legacy generated task so it doesn't double.
    if (SIGNAL_COVERED_TASK_KEYS.has(key)) continue;
    const task = TASK_CATALOG.find((ct) => ct.key === key);
    if (!task) continue;
    const booksManagedBy =
      client.booksManagedBy === 'firm' || client.booksManagedBy === 'client' ? client.booksManagedBy : null;
    const owner = resolveEffectiveOwner(
      task,
      parseResponsibilities(client.taskResponsibilities),
      parseResponsibilities(client.enterpriseDefaults),
      booksManagedBy,
    );
    const due = t.dueDate ? new Date(t.dueDate) : null;
    const overdue = due ? due.getTime() < now : false;
    out.push({
      r: {
        key: `rtask:${t.id}`,
        orgId: t.organizationId,
        ownerUserId: client.ownerUserId,
        ownerIsSuper: false,
        clientName: client.orgName,
        severity: overdue ? 'blocking' : 'normal',
        sortKey: overdue ? 90 : 104,
        title: task.label,
        detail: due ? `Due ${due.toLocaleDateString()}${overdue ? ' · overdue' : ''}` : undefined,
        issueType: undefined,
        aiDetail: task.label,
        next: '/tasks',
      },
      rec: undefined,
      audience: owner === 'client' ? 'client' : 'pro',
    });
  }
  return out;
}

export async function NeedsAttentionQueue({
  clients,
  outreach,
  demo = false,
  filter = 'all',
}: {
  clients: ClientHealth[];
  outreach?: OutreachMap;
  demo?: boolean;
  filter?: AttentionAudience;
}) {
  const clientByOrg = new Map(clients.map((c) => [c.orgId, c]));

  const issueEnriched = clients.flatMap(rowsForClient).map((r) => {
    const rec = r.issueType ? outreach?.get(outreachKey(r.orgId, r.issueType)) : undefined;
    // Real clients route by the matrix (client → enterprise default → smart);
    // the demo keeps the taxonomy default so its showcase is unchanged.
    const audience = demo
      ? rowAudience(r.issueType, rec?.status)
      : audienceFor(r, rec?.status, clientByOrg.get(r.orgId));
    return { r, rec, audience };
  });

  // Scheduled recurring tasks coming due — real clients only, routed by the same
  // matrix resolution, due-date-gated (a 12/31 task won't clutter June).
  const taskEnriched = demo ? [] : await buildRecurringTaskRows(clients, clientByOrg);

  const enriched = [...issueEnriched, ...taskEnriched]
    .sort((a, b) => a.r.sortKey - b.r.sortKey)
    .filter((e) => filter === 'all' || e.audience === filter);

  const shown = enriched.slice(0, QUEUE_CAP);
  const hidden = enriched.length - shown.length;

  const rows: QueueRowData[] = shown.map(({ r, rec, audience }) => ({
    key: r.key,
    orgId: r.orgId,
    issueType: r.issueType ?? null,
    owner: audience,
    actionMode: r.issueType ? AI_ACTION_TAXONOMY[r.issueType].actionMode : null,
    clientName: r.clientName,
    title: r.title,
    detail: r.detail ?? null,
    aiDetail: r.aiDetail,
    ownerUserId: r.ownerUserId,
    ownerIsSuper: r.ownerIsSuper,
    next: r.next,
    severity: r.severity,
    aiActionLabel: r.issueType ? outreachStatusLabel(rec?.status, r.issueType) : null,
    lastContactISO: rec?.lastContactAt ? rec.lastContactAt.toISOString() : null,
    lastMessage: rec?.lastMessageBody ?? null,
    searchText: `${r.clientName} ${r.title} ${r.detail ?? ''} ${r.aiDetail}`,
  }));

  return <QueueTable rows={rows} demo={demo} hiddenCount={hidden} cap={QUEUE_CAP} emptyMessage={EMPTY_MESSAGE[filter]} />;
}
