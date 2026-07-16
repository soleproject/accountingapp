import 'server-only';
import { and, eq, gte, lte, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  accountingPeriods,
  bills,
  billLines,
  bookReviewFindings,
  contacts,
  invoices,
  invoiceLines,
  journalEntries,
  onboardingState,
  organizations,
  payments,
  plaidAccounts,
  receipts,
  receiptMatchSuggestions,
  reconciliationPeriods,
  tasks,
  transactions,
} from '@/db/schema/schema';
import { findTxnsNeedingSubstantiation } from '@/lib/accounting/substantiation';
import { loadForm1099Summary } from '@/lib/reports/form-1099-data';
import { loadYearEndClose } from '@/lib/accounting/year-end-close';
import { loadSalesTaxLiability } from '@/lib/reports/sales-tax-data';
import { hasPayrollActivity } from '@/lib/accounting/payroll-signals';
import { countAllPendingByYear } from '@/lib/billing/plaid-pending';

export interface ActionCard {
  id: string;
  tier: 'blocking' | 'normal';
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  body?: string;
  actionLabel: string;
  action:
    | { kind: 'ask-ai'; prompt: string }
    | { kind: 'plaid-relink'; plaidItemId: string }
    | { kind: 'open-categorization-workspace' }
    | { kind: 'navigate'; href: string };
  dismissible?: boolean;
}

const ONBOARDING_PHASE_LABELS: Record<string, string> = {
  business_info: 'business info',
  quickbooks: 'QuickBooks',
  plaid: 'bank connection',
  bank_statements: 'bank statements',
  receipts: 'receipts',
  review: 'review',
  complete: 'complete',
};

function formatDollars(amount: number): string {
  return '$' + Math.round(amount).toLocaleString('en-US');
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDateOffsetDays(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function nearestQuarterlyTaxDeadline(today: Date, windowDays: number): Date | null {
  const y = today.getFullYear();
  const candidates = [
    new Date(y, 0, 15),
    new Date(y, 3, 15),
    new Date(y, 5, 15),
    new Date(y, 8, 15),
    new Date(y + 1, 0, 15),
  ];
  for (const d of candidates) {
    const days = Math.ceil((d.getTime() - today.getTime()) / 86_400_000);
    if (days >= 0 && days <= windowDays) return d;
  }
  return null;
}

function nearestPayrollFilingDeadline(today: Date, windowDays: number): Date | null {
  // Form 941 quarterly deadlines: Jan 31, Apr 30, Jul 31, Oct 31.
  const y = today.getFullYear();
  const candidates = [
    new Date(y, 0, 31),
    new Date(y, 3, 30),
    new Date(y, 6, 31),
    new Date(y, 9, 31),
    new Date(y + 1, 0, 31),
  ];
  for (const d of candidates) {
    const days = Math.ceil((d.getTime() - today.getTime()) / 86_400_000);
    if (days >= 0 && days <= windowDays) return d;
  }
  return null;
}

function nextAnnualDeadline(mmdd: string, today: Date, windowDays: number): Date | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(mmdd);
  if (!m) return null;
  const mo = Number(m[1]) - 1;
  const day = Number(m[2]);
  if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
  const y = today.getFullYear();
  for (const d of [new Date(y, mo, day), new Date(y + 1, mo, day)]) {
    const days = Math.ceil((d.getTime() - today.getTime()) / 86_400_000);
    if (days >= 0 && days <= windowDays) return d;
  }
  return null;
}

function daysUntil(target: Date): number {
  return Math.ceil((target.getTime() - Date.now()) / 86_400_000);
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? singular + 's');
}

/**
 * Compute the action-card list for an org. Pure data-fetching — no auth.
 * Auth and error responses live at the entry points (route handler / page).
 *
 * Bills: status='posted' is the unpaid-and-real signal. Schema default 'open'
 * is vestigial and never written by createBill — see app/(app)/bills/_actions.
 * Reconciliation enum: OPEN | RECONCILED | ARCHIVED — we filter for OPEN
 * with a non-zero precomputed `difference`.
 */
export async function getActionCards(orgId: string): Promise<ActionCard[]> {
  const today = todayIsoDate();
  const oneWeek = isoDateOffsetDays(7);
  const currentYear = new Date().getFullYear();

  const [
    orgRow,
    onboardingRow,
    brokenPlaid,
    toReviewAgg,
    categorizingAgg,
    overdueBillsAgg,
    billsThisWeekAgg,
    overdueInvoicesAgg,
    offReconRows,
    draftJeAgg,
    receiptMatchRows,
    bookFindingsAgg,
    substantiationNeeding,
    form1099Summary,
    yearEndClose,
    unappliedPaymentsAgg,
    salesTax,
    monthCloseRows,
    bankPending,
    receiptsUnpostedAgg,
    overdueTasksAgg,
  ] = await Promise.all([
    db
      .select({
        name: organizations.name,
        formationState: organizations.formationState,
        annualReportDue: organizations.annualReportDue,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),

    db
      .select({ phase: onboardingState.phase, completed: onboardingState.completed })
      .from(onboardingState)
      .where(eq(onboardingState.orgId, orgId))
      .limit(1),

    db
      .select({
        plaidItemId: plaidAccounts.plaidItemId,
        institutionName: plaidAccounts.institutionName,
      })
      .from(plaidAccounts)
      .where(
        and(
          eq(plaidAccounts.linkedOrganizationId, orgId),
          eq(plaidAccounts.inScope, true),
          or(
            ne(plaidAccounts.connectionStatus, 'connected'),
            eq(plaidAccounts.syncStatus, 'error'),
          ),
        ),
      ),

    db
      .select({
        count: sql<number>`count(*)::int`,
        oldest: sql<string | null>`min(${transactions.date})`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, orgId),
          sql`${transactions.reviewed} IS NOT TRUE`,
        ),
      ),

    // Rows the auto-categorizer is still working on (no category, no JE,
    // created within the last 15 min — same window as the "Categorizing…"
    // row state on /transactions). The to-review card hides while these
    // are non-zero so the user doesn't review a queue that's still settling.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, orgId),
          sql`${transactions.categoryAccountId} IS NULL`,
          sql`${transactions.journalEntryId} IS NULL`,
          sql`${transactions.createdAt} > now() - interval '15 minutes'`,
        ),
      ),

    db
      .select({
        count: sql<number>`count(distinct ${bills.id})::int`,
        totalAmount: sql<number>`coalesce(sum(${billLines.amount}), 0)::float`,
        oldestDue: sql<string | null>`min(${bills.dueDate})`,
      })
      .from(bills)
      .leftJoin(billLines, eq(billLines.billId, bills.id))
      .where(
        and(
          eq(bills.organizationId, orgId),
          eq(bills.status, 'posted'),
          lt(bills.dueDate, today),
        ),
      ),

    db
      .select({
        count: sql<number>`count(distinct ${bills.id})::int`,
        totalAmount: sql<number>`coalesce(sum(${billLines.amount}), 0)::float`,
      })
      .from(bills)
      .leftJoin(billLines, eq(billLines.billId, bills.id))
      .where(
        and(
          eq(bills.organizationId, orgId),
          eq(bills.status, 'posted'),
          gte(bills.dueDate, today),
          lte(bills.dueDate, oneWeek),
        ),
      ),

    db
      .select({
        count: sql<number>`count(distinct ${invoices.id})::int`,
        totalAmount: sql<number>`coalesce(sum(${invoiceLines.amount}), 0)::float`,
      })
      .from(invoices)
      .leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.organizationId, orgId),
          ne(invoices.status, 'paid'),
          eq(invoices.posted, true),
          lt(invoices.dueDate, today),
        ),
      ),

    db
      .select({
        accountId: reconciliationPeriods.accountId,
        difference: reconciliationPeriods.difference,
      })
      .from(reconciliationPeriods)
      .where(
        and(
          eq(reconciliationPeriods.organizationId, orgId),
          eq(reconciliationPeriods.status, 'OPEN'),
          sql`${reconciliationPeriods.difference} IS NOT NULL AND ${reconciliationPeriods.difference} != 0`,
        ),
      ),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.organizationId, orgId),
          eq(journalEntries.posted, false),
          sql`${journalEntries.createdAt} < (now() - interval '7 days')`,
        ),
      ),

    // Receipt ↔ transaction match cards. We pull two flavors in one
    // query: pending suggestions (need user review) and auto-applied
    // ones (need user verification or undo). Grouped by receipt so a
    // receipt with multiple candidates still produces one card.
    db
      .select({
        receiptId: receiptMatchSuggestions.receiptId,
        status: receiptMatchSuggestions.status,
        vendorName: contacts.contactName,
        receiptTotal: receipts.totalAmount,
        candidateCount: sql<number>`count(*)::int`,
        topConfidence: sql<string>`max(${receiptMatchSuggestions.confidence})`,
      })
      .from(receiptMatchSuggestions)
      .innerJoin(receipts, eq(receiptMatchSuggestions.receiptId, receipts.id))
      .leftJoin(contacts, eq(receipts.contactId, contacts.id))
      .where(
        and(
          eq(receiptMatchSuggestions.organizationId, orgId),
          sql`${receiptMatchSuggestions.status} IN ('pending', 'auto_applied')`,
        ),
      )
      .groupBy(
        receiptMatchSuggestions.receiptId,
        receiptMatchSuggestions.status,
        contacts.contactName,
        receipts.totalAmount,
      ),

    // Open book-review findings (audit layer), grouped by kind. hasUnbalanced
    // promotes the integrity card to high priority — a trial balance that
    // doesn't tie out is the most urgent correctness signal.
    db
      .select({
        kind: bookReviewFindings.kind,
        count: sql<number>`count(*)::int`,
        hasUnbalanced: sql<boolean>`bool_or(${bookReviewFindings.code} = 'BAL_UNBALANCED')`,
      })
      .from(bookReviewFindings)
      .where(
        and(
          eq(bookReviewFindings.organizationId, orgId),
          eq(bookReviewFindings.status, 'open'),
        ),
      )
      .groupBy(bookReviewFindings.kind),

    // Transactions in the last 30 days that need IRS documentation (meals,
    // travel, gifts, vehicle, charitable) — same window the /substantiation
    // page uses. Wrapped so a failure can't take down the whole card set.
    findTxnsNeedingSubstantiation(orgId, 30).catch(() => []),

    // 1099/W-9 prep + year-end close — same loaders the /reports/form-1099 and
    // /year-end-close pages use, so the counts match. Null-safe on failure.
    loadForm1099Summary(orgId, currentYear).catch(() => null),
    loadYearEndClose(orgId, currentYear - 1).catch(() => null),

    // Payments recorded but not applied to an invoice or bill (matches
    // paymentsOpener) — a real reconciliation gap.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.organizationId, orgId), sql`${payments.invoiceId} is null`, sql`${payments.billId} is null`)),

    // Sales tax collected but not yet remitted (current liability owed). Only
    // orgs that actually collect sales tax have the payable account.
    loadSalesTaxLiability(orgId, `${currentYear}-01-01`, today).catch(() => null),

    // Monthly accounting periods for the current year — to nudge closing
    // completed months (only for orgs already using monthly close).
    db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.organizationId, orgId), eq(accountingPeriods.year, currentYear))),

    // Bank-feed transactions synced but not yet promoted into the books
    // (pre-promotion — distinct from the post-promotion to-review queue).
    countAllPendingByYear(orgId).catch(() => []),

    // Receipts uploaded/extracted but not yet posted (matches receiptsOpener).
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.organizationId, orgId), eq(receipts.posted, false))),

    // System-created task rows (recon, meetings, recordings, AI) past due.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.organizationId, orgId), eq(tasks.status, 'OPEN'), sql`${tasks.dueDate} < now()`)),
  ]);

  const cards: ActionCard[] = [];

  // ── Plaid reconnect (blocking, p1) — one card per Plaid item ──────
  const itemBuckets = new Map<string, { institutionName: string | null; count: number }>();
  for (const a of brokenPlaid) {
    const cur = itemBuckets.get(a.plaidItemId);
    if (cur) cur.count += 1;
    else itemBuckets.set(a.plaidItemId, { institutionName: a.institutionName, count: 1 });
  }
  for (const [itemId, info] of itemBuckets) {
    cards.push({
      id: `plaid-reauth:${itemId}`,
      tier: 'blocking',
      priority: 1,
      title: `Reconnect ${info.institutionName ?? 'bank'}`,
      body: info.count > 1 ? `${info.count} accounts affected` : undefined,
      actionLabel: 'Reconnect',
      action: { kind: 'plaid-relink', plaidItemId: itemId },
    });
  }

  // ── Onboarding incomplete (blocking, p2) ──────────────────────────
  const onboarding = onboardingRow[0];
  if (onboarding && !onboarding.completed) {
    const orgName = orgRow[0]?.name ?? 'your business';
    const phaseLabel = ONBOARDING_PHASE_LABELS[onboarding.phase] ?? onboarding.phase;
    cards.push({
      id: 'onboarding',
      tier: 'blocking',
      priority: 2,
      title: `Finish setting up ${orgName}`,
      body: `On step: ${phaseLabel}`,
      actionLabel: 'Continue',
      action: { kind: 'ask-ai', prompt: 'Help me continue setting up my account.' },
    });
  }

  // ── Bills overdue (normal, p1) ────────────────────────────────────
  const billsOverdue = overdueBillsAgg[0];
  if (billsOverdue && billsOverdue.count > 0) {
    const oldestDays = billsOverdue.oldestDue
      ? Math.max(0, Math.floor((Date.now() - new Date(billsOverdue.oldestDue).getTime()) / 86_400_000))
      : 0;
    cards.push({
      id: 'bills-overdue',
      tier: 'normal',
      priority: 1,
      title: `${billsOverdue.count} ${pluralize(billsOverdue.count, 'bill')} overdue`,
      body:
        `${formatDollars(billsOverdue.totalAmount)}` +
        (oldestDays > 0 ? ` · oldest ${oldestDays} ${pluralize(oldestDays, 'day')}` : ''),
      actionLabel: 'Show me',
      action: { kind: 'ask-ai', prompt: 'Open my overdue bills and walk me through what I owe.' },
    });
  }

  // ── Reconciliation off (normal, p1) ───────────────────────────────
  if (offReconRows.length > 0) {
    let largest = 0;
    for (const r of offReconRows) {
      const diff = Math.abs(Number(r.difference ?? 0));
      if (diff > largest) largest = diff;
    }
    cards.push({
      id: 'reconciliation-off',
      tier: 'normal',
      priority: 1,
      title:
        offReconRows.length === 1
          ? `Reconciliation off by ${formatDollars(largest)}`
          : `Reconciliation off across ${offReconRows.length} accounts`,
      body:
        offReconRows.length > 1
          ? `Largest difference ${formatDollars(largest)}`
          : undefined,
      actionLabel: 'Help me',
      action: {
        kind: 'ask-ai',
        prompt: "Help me reconcile my account — there's a difference I need to track down.",
      },
    });
  }

  // ── Book review findings: integrity + duplicates + anomalies (audit layer) ──
  let dupFindings = 0;
  let integrityFindings = 0;
  let anomalyFindings = 0;
  let booksUnbalanced = false;
  for (const row of bookFindingsAgg) {
    if (row.kind === 'duplicate') dupFindings = row.count;
    else if (row.kind === 'integrity') {
      integrityFindings = row.count;
      booksUnbalanced = !!row.hasUnbalanced;
    } else if (row.kind === 'anomaly') anomalyFindings = row.count;
  }
  if (integrityFindings > 0) {
    cards.push({
      id: 'book-review-integrity',
      tier: 'normal',
      priority: booksUnbalanced ? 1 : 2,
      title: booksUnbalanced
        ? "Your books don't tie out"
        : `Review ${integrityFindings} bookkeeping ${pluralize(integrityFindings, 'issue')}`,
      body: booksUnbalanced ? 'Trial balance is out of balance' : undefined,
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/book-review?kind=integrity' },
    });
  }
  if (dupFindings > 0) {
    cards.push({
      id: 'book-review-duplicates',
      tier: 'normal',
      priority: 2,
      title: `Review ${dupFindings} possible duplicate ${pluralize(dupFindings, 'transaction')}`,
      body: 'Same amount and date from more than one source',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/book-review?kind=duplicate' },
    });
  }
  if (anomalyFindings > 0) {
    cards.push({
      id: 'book-review-anomalies',
      tier: 'normal',
      priority: 3,
      title: `Review ${anomalyFindings} unusual ${pluralize(anomalyFindings, 'transaction')}`,
      body: 'Amounts or categories that look off versus this vendor’s history',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/book-review?kind=anomaly' },
    });
  }

  // ── IRS documentation needed (normal, p3) ─────────────────────────
  // Recent meals/travel/gifts/vehicle/charitable transactions that need
  // substantiation. Navigates to the IRS Docs page — accountants can request
  // it from the client there; owners can attach it themselves.
  if (substantiationNeeding.length > 0) {
    const n = substantiationNeeding.length;
    cards.push({
      id: 'irs-substantiation',
      tier: 'normal',
      priority: 3,
      title: `${n} ${pluralize(n, 'transaction')} need IRS documentation`,
      body: 'Meals, travel, gifts, vehicle, or charitable',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/substantiation' },
    });
  }

  // ── 1099 / W-9 prep (normal, p3) ──────────────────────────────────
  // Vendors over the $600 threshold who are missing a W-9 or TIN — you can't
  // file their 1099-NEC without it. Collecting early is fine year-round.
  if (form1099Summary && form1099Summary.totals.missingPaperwork > 0) {
    const n = form1099Summary.totals.missingPaperwork;
    cards.push({
      id: 'form-1099-w9',
      tier: 'normal',
      priority: 3,
      title: `${n} 1099 ${pluralize(n, 'vendor')} missing a W-9`,
      body: `Collect before filing their 1099-NEC${n === 1 ? '' : 's'}`,
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/reports/form-1099' },
    });
  }

  // ── Year-end close items (normal, p3) ─────────────────────────────
  if (yearEndClose) {
    const attention = yearEndClose.items.filter((i) => i.status === 'attention').length;
    if (attention > 0) {
      cards.push({
        id: 'year-end-close',
        tier: 'normal',
        priority: 3,
        title: `Year-end close — ${attention} ${pluralize(attention, 'item')} to finish`,
        body: `${currentYear - 1} books`,
        actionLabel: 'Review',
        action: { kind: 'navigate', href: '/year-end-close' },
      });
    }
  }

  // ── Unapplied payments (normal, p2) ───────────────────────────────
  const unapplied = unappliedPaymentsAgg[0]?.count ?? 0;
  if (unapplied > 0) {
    cards.push({
      id: 'unapplied-payments',
      tier: 'normal',
      priority: 2,
      title: `${unapplied} ${pluralize(unapplied, 'payment')} not applied`,
      body: 'Recorded but not matched to an invoice or bill',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/payments' },
    });
  }

  // ── Sales tax to remit (normal, p3) ───────────────────────────────
  if (salesTax && salesTax.hasAccount && salesTax.endingBalance > 0.5) {
    cards.push({
      id: 'sales-tax-due',
      tier: 'normal',
      priority: 3,
      title: `${formatDollars(salesTax.endingBalance)} sales tax to remit`,
      body: 'Collected but not yet paid to the authority',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/reports/sales-tax' },
    });
  }

  // ── Month-end close due (normal, p3) ──────────────────────────────
  // Only nudge orgs already using monthly close (≥1 settled period this year)
  // so we don't nag orgs that don't close monthly. "Completed" months =
  // months fully elapsed this year; behind = those not yet reviewed/locked.
  const settledMonths = monthCloseRows.filter((r) => r.status === 'closed' || r.status === 'reviewed').length;
  const monthsElapsed = new Date().getMonth(); // 0-based → count of full months before the current one
  const monthsBehind = Math.max(0, monthsElapsed - settledMonths);
  if (settledMonths > 0 && monthsBehind > 0) {
    cards.push({
      id: 'month-end-close',
      tier: 'normal',
      priority: 3,
      title: `Close ${monthsBehind} ${pluralize(monthsBehind, 'month')} for ${currentYear}`,
      body: 'Completed months not yet reviewed or locked',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/period-close' },
    });
  }

  // ── Bank feed waiting to be promoted (normal, p2) ─────────────────
  const bankPendingTotal = bankPending.reduce((s, p) => s + p.count, 0);
  if (bankPendingTotal > 0) {
    cards.push({
      id: 'bank-feed-pending',
      tier: 'normal',
      priority: 2,
      title: `${bankPendingTotal.toLocaleString()} bank ${pluralize(bankPendingTotal, 'transaction')} to add to your books`,
      body: 'Synced from your bank but not yet in the ledger',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/plaid-feed' },
    });
  }

  // ── Receipts uploaded but not posted (normal, p3) ─────────────────
  const receiptsUnposted = receiptsUnpostedAgg[0]?.count ?? 0;
  if (receiptsUnposted > 0) {
    cards.push({
      id: 'receipts-unposted',
      tier: 'normal',
      priority: 3,
      title: `${receiptsUnposted} ${pluralize(receiptsUnposted, 'receipt')} uploaded, not posted`,
      body: 'Match and post so they link to the books',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/receipts' },
    });
  }

  // ── Overdue tasks (normal, p2) ────────────────────────────────────
  const overdueTasks = overdueTasksAgg[0]?.count ?? 0;
  if (overdueTasks > 0) {
    cards.push({
      id: 'overdue-tasks',
      tier: 'normal',
      priority: 2,
      title: `${overdueTasks} ${pluralize(overdueTasks, 'task')} overdue`,
      body: 'Past their due date',
      actionLabel: 'Show me',
      action: { kind: 'navigate', href: '/tasks' },
    });
  }

  // ── To-review transactions (normal, p2) ───────────────────────────
  // Includes both uncategorized rows and auto-categorized rows the user
  // hasn't approved yet — same queue the /transactions?filter=to_review
  // page renders. Title and destination must match: workspace only handles
  // the uncategorized subset, so route to the queue page which handles both.
  // Also wait for any in-flight "Categorizing…" rows to settle so the user
  // doesn't review a queue the auto-categorizer is still about to touch.
  const toReview = toReviewAgg[0];
  const stillCategorizing = (categorizingAgg[0]?.count ?? 0) > 0;
  if (toReview && toReview.count > 0 && !stillCategorizing) {
    const oldestDays = toReview.oldest
      ? Math.max(0, Math.floor((Date.now() - new Date(toReview.oldest).getTime()) / 86_400_000))
      : 0;
    const countLabel = toReview.count > 99 ? '99+' : String(toReview.count);
    cards.push({
      id: 'to-review',
      tier: 'normal',
      priority: 2,
      title: `Review ${countLabel} ${pluralize(toReview.count, 'transaction')}`,
      body: oldestDays > 0 ? `Oldest sitting ${oldestDays} ${pluralize(oldestDays, 'day')}` : undefined,
      actionLabel: 'Show me',
      action: { kind: 'navigate', href: '/transactions?filter=to_review&guide=1' },
    });
  }

  // ── Overdue invoices / AR (normal, p2) ────────────────────────────
  const invoicesOverdue = overdueInvoicesAgg[0];
  if (invoicesOverdue && invoicesOverdue.count > 0) {
    cards.push({
      id: 'invoices-overdue',
      tier: 'normal',
      priority: 2,
      title: `${invoicesOverdue.count} ${pluralize(invoicesOverdue.count, 'invoice')} overdue`,
      body: formatDollars(invoicesOverdue.totalAmount),
      actionLabel: 'Follow up',
      action: { kind: 'navigate', href: '/invoices/follow-up' },
    });
  }

  // ── Bills due this week (normal, p3) ──────────────────────────────
  const billsWeek = billsThisWeekAgg[0];
  if (billsWeek && billsWeek.count > 0) {
    cards.push({
      id: 'bills-this-week',
      tier: 'normal',
      priority: 3,
      title: `${billsWeek.count} ${pluralize(billsWeek.count, 'bill')} due this week`,
      body: formatDollars(billsWeek.totalAmount),
      actionLabel: 'Show me',
      action: { kind: 'ask-ai', prompt: "Open my bills and walk me through what's due this week." },
    });
  }

  // ── Draft journal entries (normal, p3) ────────────────────────────
  const draftJe = draftJeAgg[0];
  if (draftJe && draftJe.count > 0) {
    cards.push({
      id: 'draft-jes',
      tier: 'normal',
      priority: 3,
      title: `${draftJe.count} draft ${pluralize(draftJe.count, 'journal entry', 'journal entries')}`,
      body: 'Older than 7 days',
      actionLabel: 'Walk me through',
      action: { kind: 'ask-ai', prompt: 'Walk me through my unposted journal entries.' },
    });
  }

  // ── Receipt ↔ transaction match cards (normal) ────────────────────
  // Two flavors:
  //   - auto-applied (p2): "Auto-applied — verify or undo". The match
  //     ran at upload time; the user just confirms or rolls back.
  //   - pending (p3): "Review match". Lower priority because the user
  //     still has to make a decision; auto-applied items are more
  //     urgent because they already changed the GL.
  for (const row of receiptMatchRows) {
    const vendor = row.vendorName ?? 'unknown vendor';
    const total = Number(row.receiptTotal ?? 0);
    const confidence = Number(row.topConfidence ?? 0);
    if (row.status === 'auto_applied') {
      cards.push({
        id: `receipt-match-applied:${row.receiptId}`,
        tier: 'normal',
        priority: 2,
        title: `${vendor} receipt auto-applied to a transaction`,
        body: `${formatDollars(total)} · ${Math.round(confidence * 100)}% match — verify or undo`,
        actionLabel: 'Review',
        action: { kind: 'navigate', href: `/receipts/${row.receiptId}?showMatches=1` },
      });
    } else {
      const candidateLabel = row.candidateCount === 1
        ? 'a transaction'
        : `${row.candidateCount} transactions`;
      cards.push({
        id: `receipt-match:${row.receiptId}`,
        tier: 'normal',
        priority: 3,
        title: `${vendor} receipt may match ${candidateLabel}`,
        body:
          `${formatDollars(total)}` +
          (confidence >= 0.8 ? ` · ${Math.round(confidence * 100)}% confident` : ''),
        actionLabel: 'Review match',
        action: { kind: 'navigate', href: `/receipts/${row.receiptId}?showMatches=1` },
      });
    }
  }

  // ── Quarterly tax deadline (normal, p4, dismissible) ──────────────
  const deadline = nearestQuarterlyTaxDeadline(new Date(), 14);
  if (deadline) {
    const days = daysUntil(deadline);
    cards.push({
      id: `quarterly-tax:${deadline.toISOString().slice(0, 10)}`,
      tier: 'normal',
      priority: 4,
      title: `Estimated taxes due ${deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      body: days <= 0 ? 'Today' : `In ${days} ${pluralize(days, 'day')}`,
      actionLabel: 'Help me',
      action: {
        kind: 'ask-ai',
        prompt: 'Help me prepare for the upcoming quarterly tax deadline.',
      },
      dismissible: true,
    });
  }

  // ── Payroll tax filing deadline (normal, p4, dismissible) ─────────
  // Only orgs that actually run payroll (real payroll-account activity) get the
  // Form 941 nudge — and we only pay for that check when a deadline is near.
  const payrollDeadline = nearestPayrollFilingDeadline(new Date(), 14);
  if (payrollDeadline && (await hasPayrollActivity(orgId))) {
    const days = daysUntil(payrollDeadline);
    cards.push({
      id: `payroll-tax:${payrollDeadline.toISOString().slice(0, 10)}`,
      tier: 'normal',
      priority: 4,
      title: `Payroll taxes due ${payrollDeadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      body: days <= 0 ? 'Form 941 due today' : `Form 941 due in ${days} ${pluralize(days, 'day')}`,
      actionLabel: 'Help me',
      action: {
        kind: 'ask-ai',
        prompt: 'Help me prepare for the upcoming payroll tax filing deadline (Form 941).',
      },
      dismissible: true,
    });
  }

  // ── State annual-report deadline (normal, p4, dismissible) ────────
  // Fires off the firm-set annual_report_due (MM-DD); no date set = no nudge.
  const arDue = orgRow[0]?.annualReportDue;
  const arDeadline = arDue ? nextAnnualDeadline(arDue, new Date(), 21) : null;
  if (arDeadline) {
    const days = daysUntil(arDeadline);
    const st = orgRow[0]?.formationState ? `${orgRow[0].formationState} ` : '';
    cards.push({
      id: `annual-report:${arDeadline.toISOString().slice(0, 10)}`,
      tier: 'normal',
      priority: 4,
      title: `${st}annual report due ${arDeadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      body: days <= 0 ? 'Due today' : `Due in ${days} ${pluralize(days, 'day')}`,
      actionLabel: 'Help me',
      action: {
        kind: 'ask-ai',
        prompt: 'Help me prepare and file my state annual report.',
      },
      dismissible: true,
    });
  }

  cards.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'blocking' ? -1 : 1;
    return a.priority - b.priority;
  });

  return cards;
}
