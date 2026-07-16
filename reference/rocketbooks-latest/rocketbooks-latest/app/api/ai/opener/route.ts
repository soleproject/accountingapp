import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { and, asc, count, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  transactions,
  reconciliationPeriods,
  chartOfAccounts,
  receipts,
  tasks,
  inboxMessages,
  payments,
  contacts,
  plaidAccounts,
  qboConnections,
  plaidRawTransactions,
  fixedAssets,
  loans,
  tagDimensions,
  rentalProperties,
  bookReviewFindings,
  accountingPeriods,
  journalEntries,
  aiClientOutreach,
} from '@/db/schema/schema';
import { countAllPendingByYear } from '@/lib/billing/plaid-pending';
import { chatCompletion } from '@/lib/ai/openai';
import type { UsageCtx } from '@/lib/ai/usage';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { CFO_PERSONA } from '@/lib/ai/persona';
import {
  buildClientContext,
  deriveChips,
  getFirstName,
  hasSubstantiveBooks,
  renderContextBlock,
  type SuggestionChip,
} from '@/lib/ai/client-context';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { overdueInvoicesByCustomer, overdueInvoicesMissingEmail } from '@/lib/enterprise/ar-collections';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { loadForm1099Summary } from '@/lib/reports/form-1099-data';
import { findTxnsNeedingSubstantiation } from '@/lib/accounting/substantiation';
import { loadYearEndClose } from '@/lib/accounting/year-end-close';
import { loadPulse } from '@/app/(app)/pulse/_data/loader';
import { normalizeContactNameForMatch } from '@/lib/accounting/normalize-contact-name';
import { getActionCards } from '@/lib/server/action-cards';

export const runtime = 'nodejs';

interface OpenerResponse {
  greeting: string | null;
  chips: SuggestionChip[];
}

/**
 * The proactive opener: a warm, books-grounded greeting the AI leads the
 * conversation with the moment the user lands on /ai-chat — plus dynamic
 * suggestion chips derived from their actual situation. Only fires once
 * onboarding is complete; a fresh org with empty books has nothing to surface
 * and keeps the existing onboarding greeting instead.
 */
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/**
 * Invoices-page opener: a brief, factual read on outstanding/overdue invoices.
 * When invoices are overdue, it offers to chase them (the chip / a "yes" routes
 * to the overdue follow-up workflow). Templated — instant and precise.
 */
async function invoicesOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [inv, chaseable, fillable, firstName] = await Promise.all([
    getOutstandingInvoices(orgId).catch(() => []),
    // Same two sources the follow-up page uses, so the chat reconciles exactly
    // with it: chaseable = overdue we can email now; fillable = overdue held
    // back only for a blank customer email (the page lets you add it inline).
    overdueInvoicesByCustomer(orgId).catch(() => []),
    overdueInvoicesMissingEmail(orgId).catch(() => []),
    getFirstName(userId).catch(() => null),
  ]);
  const youHave = firstName ? `${firstName}, you have` : 'You have';
  if (inv.length === 0) {
    return { greeting: `${youHave} no outstanding invoices right now — all caught up. ✓`, chips: [] };
  }
  const total = inv.reduce((s, i) => s + i.balance, 0);
  const todayMs = Date.now();
  const overdue = inv.filter((i) => i.dueDate && Date.parse(`${i.dueDate}T00:00:00`) < todayMs);
  const overdueAmt = overdue.reduce((s, i) => s + i.balance, 0);
  const n = `${inv.length} outstanding invoice${inv.length === 1 ? '' : 's'} totaling ${money(total)}`;

  if (overdue.length > 0) {
    // How many overdue can we email now, and how many are held back only for a
    // blank customer email (fillable inline on the follow-up page). These two
    // sources match the page exactly. (Any remainder — e.g. archived customers
    // — isn't surfaced on the page either, so we don't claim it here.)
    const chaseableCount = chaseable.reduce((s, c) => s + c.invoices.length, 0);
    const chaseableAmt = chaseable.reduce((s, c) => s + c.totalCents, 0) / 100;
    const fillableCount = fillable.reduce((s, c) => s + c.invoices.length, 0);
    const fillableAmt = fillable.reduce((s, c) => s + c.totalCents, 0) / 100;
    const fillNote =
      fillableCount > 0
        ? ` and another ${fillableCount} (${money(fillableAmt)}) just need a customer email, which you can add right on the follow-up page`
        : '';
    const reachNote =
      chaseableCount > 0
        ? ` I can email reminders for ${chaseableCount} of them (${money(chaseableAmt)}) right now${fillNote}.`
        : fillableCount > 0
          ? ` ${fillableCount} of them (${money(fillableAmt)}) just need a customer email — add one on the follow-up page and we'll send.`
          : ` These need a customer email or contact before I can send reminders.`;
    return {
      greeting: `${youHave} ${n} — ${overdue.length} ${overdue.length === 1 ? 'is' : 'are'} overdue (${money(overdueAmt)} past due).${reachNote} Want me to help you follow up on the ones I can reach?`,
      chips: [
        { label: 'Follow up on overdue', prompt: 'Yes — take me to the overdue-invoice follow-up so I can chase them.' },
        { label: 'Show overdue invoices', prompt: 'Show me my overdue invoices.' },
      ],
    };
  }
  return {
    greeting: `${youHave} ${n}, and none are overdue — nicely on top of it.`,
    chips: [{ label: 'Show outstanding invoices', prompt: 'Show me my outstanding invoices.' }],
  };
}

/**
 * Bills-page opener: a read on unpaid/overdue bills. When bills are overdue it
 * offers to pull up the ones to pay (the AI never moves money — it takes the
 * user to the bills, they pay). Templated.
 */
async function billsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [bills, firstName] = await Promise.all([
    getOutstandingBills(orgId).catch(() => []),
    getFirstName(userId).catch(() => null),
  ]);
  const youHave = firstName ? `${firstName}, you have` : 'You have';
  if (bills.length === 0) {
    return { greeting: `${youHave} no unpaid bills right now — all clear. ✓`, chips: [] };
  }
  const total = bills.reduce((s, b) => s + b.balance, 0);
  const todayMs = Date.now();
  const overdue = bills.filter((b) => b.dueDate && Date.parse(`${b.dueDate}T00:00:00`) < todayMs);
  const overdueAmt = overdue.reduce((s, b) => s + b.balance, 0);
  const n = `${bills.length} unpaid bill${bills.length === 1 ? '' : 's'} totaling ${money(total)}`;

  if (overdue.length > 0) {
    return {
      greeting: `${youHave} ${n} — ${overdue.length} ${overdue.length === 1 ? 'is' : 'are'} overdue (${money(overdueAmt)} past due). Want me to pull up the ones to pay?`,
      chips: [
        { label: 'Pull up bills to pay', prompt: 'Yes — take me to the overdue bills so I can pay them.' },
        { label: 'Show overdue bills', prompt: 'Show me my overdue bills.' },
      ],
    };
  }
  return {
    greeting: `${youHave} ${n}, and none are overdue yet — you're on top of it.`,
    chips: [{ label: 'Show unpaid bills', prompt: 'Show me my unpaid bills.' }],
  };
}

/**
 * Transactions-page opener: how many transactions are waiting for review, with
 * an offer to categorize them in the AI workspace. Templated.
 */
async function transactionsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [reviewedFalseRow, toVerifyRow, firstName] = await Promise.all([
    db.select({ n: count() }).from(transactions).where(and(eq(transactions.organizationId, orgId), eq(transactions.reviewed, false))).then((r) => r[0]),
    db.select({ n: count() }).from(transactions).where(and(eq(transactions.organizationId, orgId), eq(transactions.reviewed, true), eq(transactions.verified, false))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const toReview = Number(reviewedFalseRow?.n ?? 0);
  const toVerify = Number(toVerifyRow?.n ?? 0);
  if (toReview === 0 && toVerify === 0) {
    return { greeting: `${firstName ? `${firstName}, your` : 'Your'} transaction review queue is clear — nothing to go over right now. ✓`, chips: [] };
  }
  // Soft, conversational intro — no scary counts. On "Yes" the assistant offers
  // the three guided review flows (handled by the system prompt's picker block).
  return {
    greeting: `${firstName ? `${firstName}, I` : 'I'}'ve got some transactions and categorizations I'd love to run past you — can we do that now?`,
    chips: [
      { label: "Yes, let's go", prompt: "Yes, let's go through them — which reviews do we have?" },
      { label: 'Not now', prompt: 'Not right now — maybe later.' },
    ],
  };
}

/** Reconciliation opener: how many open reconciliations don't balance + the
 * biggest gap, with an offer to work through them together. Templated. */
async function reconciliationOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [openRows, firstName] = await Promise.all([
    db
      .select({ diff: reconciliationPeriods.difference, accountName: chartOfAccounts.accountName })
      .from(reconciliationPeriods)
      .leftJoin(chartOfAccounts, eq(reconciliationPeriods.accountId, chartOfAccounts.id))
      .where(and(eq(reconciliationPeriods.organizationId, orgId), eq(reconciliationPeriods.status, 'OPEN'))),
    getFirstName(userId).catch(() => null),
  ]);
  if (openRows.length === 0) {
    return { greeting: `${firstName ? `${firstName}, your` : 'Your'} accounts are reconciled — nothing outstanding. ✓`, chips: [] };
  }
  const withDiff = openRows.filter((r) => r.diff != null && Math.abs(Number(r.diff)) > 0.01);
  const largest = withDiff.length ? withDiff.reduce((m, r) => (Math.abs(Number(r.diff)) > Math.abs(Number(m.diff)) ? r : m)) : null;
  const n = openRows.length;
  const youHave = firstName ? `${firstName}, you have` : 'You have';
  const tail = largest ? ` — the biggest gap is ${largest.accountName ?? 'an account'}, ${money(Math.abs(Number(largest.diff)))} off` : '';
  return {
    greeting: `${youHave} ${n} open reconciliation${n === 1 ? '' : 's'}${tail}. Want to work through ${n === 1 ? 'it' : 'them'} together?`,
    chips: [{ label: 'Start reconciling', prompt: 'Help me work through my open reconciliations.' }],
  };
}

/** Reports-page opener: offer to walk through the financials together. Light. */
async function reportsOpener(userId: string): Promise<OpenerResponse> {
  const firstName = await getFirstName(userId).catch(() => null);
  const open = firstName ? `${firstName}, your financials are here.` : 'Your financials are here.';
  return {
    greeting: `${open} Want me to walk you through your latest numbers together?`,
    chips: [
      { label: 'Walk me through the P&L', prompt: 'Open my income statement and walk me through my profit & loss for this period.' },
      { label: 'Balance sheet', prompt: 'Open my balance sheet and walk me through it.' },
      { label: 'Cash flow', prompt: 'Open my cash flow statement and walk me through it.' },
    ],
  };
}

/** 1099 opener: vendors missing a W-9/TIN, or ready to generate the forms. */
async function form1099Opener(orgId: string, userId: string): Promise<OpenerResponse> {
  const year = new Date().getFullYear();
  const [data, firstName] = await Promise.all([loadForm1099Summary(orgId, year), getFirstName(userId).catch(() => null)]);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (data.totals.vendors === 0) {
    return { greeting: `${your} books have no 1099 vendors for ${year} yet — nobody's crossed the ${money(data.threshold)} threshold.`, chips: [] };
  }
  const missing = data.totals.missingPaperwork;
  if (missing > 0) {
    return {
      greeting: `${you} have ${missing} 1099 vendor${missing === 1 ? '' : 's'} missing a W-9 or TIN before you can file their 1099-NEC${missing === 1 ? '' : 's'}. Want to chase the W-9s?`,
      chips: [
        { label: 'Request W-9s', prompt: 'Walk me through requesting the missing W-9s for my 1099 vendors.' },
        { label: 'Review 1099 vendors', prompt: 'Which vendors need a 1099 this year and what is missing?' },
      ],
    };
  }
  return {
    greeting: `${you} have ${data.totals.overThreshold} 1099 vendor${data.totals.overThreshold === 1 ? '' : 's'}, all with W-9s on file — ready to generate the 1099-NEC PDFs?`,
    chips: [{ label: 'Generate 1099-NEC PDFs', prompt: 'Help me generate the 1099-NEC PDFs for my eligible vendors.' }],
  };
}

/** Substantiation opener: recent transactions needing IRS documentation. */
async function substantiationOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [needing, firstName] = await Promise.all([
    findTxnsNeedingSubstantiation(orgId, 30).catch(() => []),
    getFirstName(userId).catch(() => null),
  ]);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (needing.length === 0) {
    return { greeting: `${your} recent transactions are all documented — nothing needs IRS substantiation right now. ✓`, chips: [] };
  }
  return {
    greeting: `${you} have ${needing.length} recent transaction${needing.length === 1 ? '' : 's'} that need IRS documentation (meals, travel, gifts, vehicle, charitable). Want to request it from your client?`,
    chips: [{ label: 'Request documentation', prompt: 'Walk me through requesting the IRS documentation from my client.' }],
  };
}

/** Year-end close opener: progress + items still needing attention. */
async function yearEndCloseOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const year = new Date().getFullYear() - 1;
  const [data, firstName] = await Promise.all([loadYearEndClose(orgId, year), getFirstName(userId).catch(() => null)]);
  const your = firstName ? `${firstName}, your` : 'Your';
  const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 100;
  const attention = data.items.filter((i) => i.status === 'attention').length;
  if (attention === 0) {
    return { greeting: `${your} ${year} books are buttoned up — the close is ${pct}% done. ✓`, chips: [] };
  }
  return {
    greeting: `${your} ${year} close is ${pct}% done — ${attention} item${attention === 1 ? '' : 's'} still need attention. Want to work through them together?`,
    chips: [{ label: 'Walk me through the close', prompt: 'Walk me through my year-end close, highest priority first.' }],
  };
}

/** Imports opener: transactions waiting to be promoted, else an offer to import. */
async function importsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [pending, firstName] = await Promise.all([countAllPendingByYear(orgId).catch(() => []), getFirstName(userId).catch(() => null)]);
  const total = pending.reduce((s, p) => s + p.count, 0);
  const you = firstName ? `${firstName}, you` : 'You';
  if (total > 0) {
    return {
      greeting: `${you} have ${total.toLocaleString()} imported transaction${total === 1 ? '' : 's'} waiting to be promoted into your books. Want to review and promote ${total === 1 ? 'it' : 'them'}?`,
      chips: [{ label: 'Review imports', prompt: 'Walk me through reviewing and promoting my imported transactions.' }],
    };
  }
  return {
    greeting: `${firstName ? `${firstName}, ready` : 'Ready'} to import a bank statement? Drop the PDF and I'll pull out the transactions, then we'll promote them into your books.`,
    chips: [{ label: 'Import a statement', prompt: 'Walk me through uploading and importing a bank statement.' }],
  };
}

/** Receipts opener: receipts uploaded but not yet posted. */
async function receiptsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db.select({ n: count() }).from(receipts).where(and(eq(receipts.organizationId, orgId), eq(receipts.posted, false))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const unposted = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (unposted === 0) {
    return { greeting: `${your} receipts are all posted — nothing waiting. ✓ Drop a new one and I'll extract it for you.`, chips: [] };
  }
  return {
    greeting: `${you} have ${unposted} receipt${unposted === 1 ? '' : 's'} uploaded but not yet posted. Want to match and post ${unposted === 1 ? 'it' : 'them'} together?`,
    chips: [{ label: 'Match & post receipts', prompt: 'Walk me through matching and posting my uploaded receipts.' }],
  };
}

// ---------------------------------------------------------------------------
// Operational pages
// ---------------------------------------------------------------------------

/** Pulse opener: cash on hand + AR/AP at a glance, offer to walk the numbers. */
async function pulseOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [data, firstName] = await Promise.all([
    loadPulse({ orgId, days: 30, withExtrapolation: false }).catch(() => null),
    getFirstName(userId).catch(() => null),
  ]);
  const your = firstName ? `${firstName}, your` : 'Your';
  if (!data) {
    return {
      greeting: `${your} business pulse is here. Want me to walk you through where things stand?`,
      chips: [{ label: 'Walk me through it', prompt: 'Walk me through my business pulse — cash, revenue, and what needs attention.' }],
    };
  }
  const k = data.kpis;
  return {
    greeting: `${your} pulse over the last 30 days: ${money(k.cashNow)} cash on hand, ${money(k.totalAr)} owed to you and ${money(k.totalAp)} you owe. Want me to walk you through what's driving it?`,
    chips: [
      { label: 'Walk me through it', prompt: 'Walk me through my business pulse — what should I focus on?' },
      { label: 'What needs attention?', prompt: 'What in my pulse needs my attention right now?' },
    ],
  };
}

/**
 * Tasks opener: leads with the "What needs your attention" action cards the
 * page actually surfaces (overdue bills/invoices, review queue, onboarding,
 * book-review findings, …) via getActionCards — NOT the raw `tasks` table,
 * which is the separate "All tasks" list and is usually empty. Falls back to
 * the manual task count only when there are no action cards.
 */
async function tasksOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [cards, openRow, firstName] = await Promise.all([
    getActionCards(orgId).catch(() => []),
    db.select({ n: count() }).from(tasks).where(and(eq(tasks.organizationId, orgId), eq(tasks.status, 'OPEN'))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const openTasks = Number(openRow?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';

  if (cards.length > 0) {
    const n = cards.length;
    const blocking = cards.filter((c) => c.tier === 'blocking').length;
    const top = cards.slice(0, 2).map((c) => c.title);
    const lead = top.length ? ` — top of the list: ${top.join(', ')}` : '';
    const blockNote = blocking > 0 ? ` (${blocking} ${blocking === 1 ? 'is blocking and' : 'are blocking and'} needs to come first)` : '';
    return {
      greeting: `${you} have ${n} thing${n === 1 ? '' : 's'} that need attention${blockNote}${lead}. Want me to walk you through them?`,
      chips: [{ label: 'Walk me through these', prompt: 'Walk me through what needs my attention, most important first.' }],
    };
  }

  if (openTasks > 0) {
    return {
      greeting: `${you} have ${openTasks} open task${openTasks === 1 ? '' : 's'}. Want to work through ${openTasks === 1 ? 'it' : 'them'} together?`,
      chips: [{ label: 'Show my tasks', prompt: 'Show me my open tasks, most urgent first.' }],
    };
  }

  return { greeting: `${your} task list is clear — nothing needs your attention right now. ✓`, chips: [] };
}

/**
 * Organizer dashboard opener — the personal work surface (tasks, next-up, inbox),
 * NOT the accounting books. Surfaces open/overdue tasks, the soonest-due item, and
 * open inbox messages so the greeting matches what's on the organizer dashboard.
 */
async function organizerDashboardOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const nowIso = new Date().toISOString();
  const [openRow, overdueRow, nextUpRow, inboxRow, firstName] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(and(eq(tasks.organizationId, orgId), eq(tasks.status, 'OPEN'))).then((r) => r[0]),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.organizationId, orgId), eq(tasks.status, 'OPEN'), isNotNull(tasks.dueDate), sql`${tasks.dueDate} < ${nowIso}`))
      .then((r) => r[0]),
    db
      .select({ title: tasks.title, dueDate: tasks.dueDate })
      .from(tasks)
      .where(and(eq(tasks.organizationId, orgId), eq(tasks.status, 'OPEN'), isNotNull(tasks.dueDate)))
      .orderBy(asc(tasks.dueDate))
      .limit(1)
      .then((r) => r[0]),
    db.select({ n: count() }).from(inboxMessages).where(and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.status, 'open'))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const openTasks = Number(openRow?.n ?? 0);
  const overdue = Number(overdueRow?.n ?? 0);
  const inbox = Number(inboxRow?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';

  if (openTasks === 0 && inbox === 0) {
    return { greeting: `${your} organizer is clear — no open tasks or inbox items right now. ✓`, chips: [] };
  }

  const bits: string[] = [];
  if (openTasks > 0) bits.push(`${openTasks} open task${openTasks === 1 ? '' : 's'}${overdue > 0 ? ` (${overdue} overdue)` : ''}`);
  if (inbox > 0) bits.push(`${inbox} inbox item${inbox === 1 ? '' : 's'} to reply to`);
  const summary = bits.join(' and ');

  let nextUpNote = '';
  if (nextUpRow?.title) {
    const days = nextUpRow.dueDate ? Math.floor((Date.now() - new Date(nextUpRow.dueDate).getTime()) / 86_400_000) : null;
    const lateNote = days != null && days > 0 ? ` — ${days} day${days === 1 ? '' : 's'} overdue` : '';
    nextUpNote = ` Next up: "${nextUpRow.title}"${lateNote}.`;
  }

  const chips: { label: string; prompt: string }[] = [];
  if (overdue > 0) chips.push({ label: `${overdue} overdue`, prompt: 'Show me my overdue tasks, most overdue first.' });
  if (openTasks > 0) chips.push({ label: 'Walk me through my tasks', prompt: 'Walk me through my open tasks, most urgent first.' });
  if (inbox > 0) chips.push({ label: `${inbox} to reply`, prompt: 'What is in my inbox that needs a reply?' });

  return {
    greeting: `${you} have ${summary}.${nextUpNote} Want to start with what's most overdue?`,
    chips: chips.slice(0, 4),
  };
}

/** Payments opener: payments not yet applied to an invoice/bill. */
async function paymentsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db.select({ n: count() }).from(payments).where(and(eq(payments.organizationId, orgId), isNull(payments.invoiceId), isNull(payments.billId))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const unapplied = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (unapplied === 0) {
    return {
      greeting: `${your} payments are all applied to invoices and bills — nothing unmatched. ✓`,
      chips: [{ label: 'Record a payment', prompt: 'Take me to record a new payment.' }],
    };
  }
  return {
    greeting: `${you} have ${unapplied} payment${unapplied === 1 ? '' : 's'} that ${unapplied === 1 ? "isn't" : "aren't"} applied to an invoice or bill yet. Want to match ${unapplied === 1 ? 'it' : 'them'} up together?`,
    chips: [{ label: 'Show unapplied payments', prompt: "Show me the payments that aren't applied to an invoice or bill yet." }],
  };
}

/** Contacts opener: surfaces likely-duplicate contact groups to merge. */
async function contactsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [rows, firstName] = await Promise.all([
    db.select({ name: contacts.contactName }).from(contacts).where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true))),
    getFirstName(userId).catch(() => null),
  ]);
  const groups = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeContactNameForMatch(r.name);
    if (!key) continue;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const dupGroups = [...groups.values()].filter((n) => n > 1).length;
  const total = rows.length;
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (dupGroups > 0) {
    return {
      greeting: `${you} have ${total} contact${total === 1 ? '' : 's'}, and I spotted ${dupGroups} group${dupGroups === 1 ? '' : 's'} that look like duplicates of the same vendor or customer. Want me to pull them up so we can merge them and keep your books clean?`,
      chips: [
        { label: 'Review duplicates', prompt: 'Show me the contacts that look like duplicates so we can merge them.' },
        { label: 'Show all contacts', prompt: 'Show me my contacts.' },
      ],
    };
  }
  return {
    greeting: `${your} contact list looks clean — ${total} contact${total === 1 ? '' : 's'} and no obvious duplicates. ✓`,
    chips: [{ label: 'Add a contact', prompt: 'Take me to add a new contact.' }],
  };
}

// ---------------------------------------------------------------------------
// Connections pages
// ---------------------------------------------------------------------------

/** Bank Connections opener: linked accounts + any not yet in the books. */
async function bankConnectionsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [accts, firstName] = await Promise.all([
    db.select({ inScope: plaidAccounts.inScope, coa: plaidAccounts.chartOfAccountId }).from(plaidAccounts).where(eq(plaidAccounts.linkedOrganizationId, orgId)),
    getFirstName(userId).catch(() => null),
  ]);
  const you = firstName ? `${firstName}, you` : 'You';
  if (accts.length === 0) {
    return {
      greeting: `${firstName ? `${firstName}, no` : 'No'} banks are connected yet. Connect your first account and I'll start pulling in transactions automatically.`,
      chips: [{ label: 'Connect a bank', prompt: 'Walk me through connecting my bank account.' }],
    };
  }
  const notInBooks = accts.filter((a) => a.coa && !a.inScope).length;
  if (notInBooks > 0) {
    return {
      greeting: `${you} have ${accts.length} linked account${accts.length === 1 ? '' : 's'}, but ${notInBooks} ${notInBooks === 1 ? "isn't" : "aren't"} in your books yet. Want to bring ${notInBooks === 1 ? 'it' : 'them'} in so the transactions post?`,
      chips: [{ label: 'Review accounts', prompt: 'Which connected accounts are not in my books yet?' }],
    };
  }
  return {
    greeting: `${you} have ${accts.length} bank account${accts.length === 1 ? '' : 's'} connected and syncing into your books. ✓ Want to connect another?`,
    chips: [{ label: 'Connect a bank', prompt: 'Walk me through connecting another bank account.' }],
  };
}

/** QBO opener: whether QuickBooks Online is connected. */
async function qboOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [conn, firstName] = await Promise.all([
    db.select({ realmId: qboConnections.realmId }).from(qboConnections).where(eq(qboConnections.orgId, orgId)).limit(1).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const your = firstName ? `${firstName}, your` : 'Your';
  if (!conn) {
    return {
      greeting: `${your} QuickBooks Online isn't connected yet. Connect it and I can pull your existing accounts, customers, and history over.`,
      chips: [{ label: 'Connect QuickBooks', prompt: 'Walk me through connecting QuickBooks Online.' }],
    };
  }
  return {
    greeting: `${your} QuickBooks Online is connected. ✓ Want to review what's syncing or pull anything else over?`,
    chips: [{ label: 'Review QBO sync', prompt: 'What is syncing from QuickBooks, and is there anything I should bring over?' }],
  };
}

/** Plaid Feed opener: synced bank transactions not yet promoted into the books. */
async function plaidFeedOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db
      .select({ n: count() })
      .from(plaidRawTransactions)
      .innerJoin(plaidAccounts, eq(plaidRawTransactions.plaidAccountId, plaidAccounts.id))
      .where(
        and(
          eq(plaidAccounts.linkedOrganizationId, orgId),
          sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.organization_id = ${orgId} AND t.reference = 'plaid:' || ${plaidRawTransactions.plaidTransactionId})`,
        ),
      )
      .then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const pending = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (pending === 0) {
    return { greeting: `${your} bank feed is all caught up — every synced transaction is in your books. ✓`, chips: [] };
  }
  return {
    greeting: `${you} have ${pending.toLocaleString()} bank-feed transaction${pending === 1 ? '' : 's'} that ${pending === 1 ? "hasn't" : "haven't"} been brought into your books yet. Want to review and post ${pending === 1 ? 'it' : 'them'} together?`,
    chips: [{ label: 'Review the feed', prompt: 'Walk me through reviewing and posting my bank-feed transactions.' }],
  };
}

/** Communications opener: client conversations awaiting a reply. */
async function communicationsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db.select({ n: count() }).from(aiClientOutreach).where(and(eq(aiClientOutreach.organizationId, orgId), eq(aiClientOutreach.status, 'awaiting_response'))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const awaiting = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (awaiting === 0) {
    return { greeting: `${your} client communications are all up to date — nothing waiting on a reply. ✓`, chips: [] };
  }
  return {
    greeting: `${you} have ${awaiting} client conversation${awaiting === 1 ? '' : 's'} still waiting on a reply. Want to review ${awaiting === 1 ? 'it' : 'them'} and decide on next steps together?`,
    chips: [{ label: 'Review conversations', prompt: 'Show me the client conversations still waiting on a reply.' }],
  };
}

// ---------------------------------------------------------------------------
// Accounting registers
// ---------------------------------------------------------------------------

/** Assets opener: active fixed assets, offer to run depreciation. */
async function assetsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db.select({ n: count() }).from(fixedAssets).where(and(eq(fixedAssets.organizationId, orgId), eq(fixedAssets.status, 'active'))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const active = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (active === 0) {
    return {
      greeting: `${your} fixed-asset register is empty. Add an asset and I'll set up its depreciation schedule.`,
      chips: [{ label: 'Add an asset', prompt: 'Walk me through adding a fixed asset.' }],
    };
  }
  return {
    greeting: `${you} have ${active} active fixed asset${active === 1 ? '' : 's'} on the books. Want to run depreciation for the period or review the register?`,
    chips: [
      { label: 'Run depreciation', prompt: 'Walk me through running depreciation for this period.' },
      { label: 'Review assets', prompt: 'Show me my fixed assets.' },
    ],
  };
}

/** Loans opener: active loans + outstanding principal. */
async function loansOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [rows, firstName] = await Promise.all([
    db.select({ principal: loans.currentPrincipal }).from(loans).where(and(eq(loans.organizationId, orgId), eq(loans.status, 'active'))),
    getFirstName(userId).catch(() => null),
  ]);
  const active = rows.length;
  const outstanding = rows.reduce((s, r) => s + Number(r.principal ?? 0), 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (active === 0) {
    return {
      greeting: `${your} loan register is empty. Add a loan and I'll build its amortization schedule.`,
      chips: [{ label: 'Add a loan', prompt: 'Walk me through adding a loan.' }],
    };
  }
  return {
    greeting: `${you} have ${active} active loan${active === 1 ? '' : 's'} with ${money(outstanding)} of principal still outstanding. Want to review the balances or record a payment?`,
    chips: [{ label: 'Review loans', prompt: 'Show me my loans and their balances.' }],
  };
}

/** Inventory opener: feature is a coming-soon stub. Keep it light and honest. */
async function inventoryOpener(userId: string): Promise<OpenerResponse> {
  const firstName = await getFirstName(userId).catch(() => null);
  return {
    greeting: `${firstName ? `${firstName}, inventory` : 'Inventory'} tracking — stock levels, COGS, and valuation — is coming to your books soon. In the meantime, is there anything else I can help with?`,
    chips: [],
  };
}

/** Tags opener: custom tag dimensions set up, offer to explore. */
async function tagsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [row, firstName] = await Promise.all([
    db.select({ n: count() }).from(tagDimensions).where(eq(tagDimensions.organizationId, orgId)).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const dims = Number(row?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  if (dims === 0) {
    return {
      greeting: `${you} haven't set up any custom tags yet. Tags let you slice your books by things like project or location — and built-in dimensions already cover rental properties, fixed assets, and loans. Want to set one up?`,
      chips: [{ label: 'Set up a tag', prompt: 'Walk me through creating a custom tag dimension.' }],
    };
  }
  return {
    greeting: `${you} have ${dims} custom tag dimension${dims === 1 ? '' : 's'} (plus the built-in ones for properties, assets, and loans). Want to explore how your books break down by tag?`,
    chips: [{ label: 'Explore by tag', prompt: 'Show me how my books break down by tag.' }],
  };
}

/** Rental Properties opener: active properties + any not linked to a building asset. */
async function rentalPropertiesOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [rows, firstName] = await Promise.all([
    db.select({ fixedAssetId: rentalProperties.fixedAssetId }).from(rentalProperties).where(and(eq(rentalProperties.organizationId, orgId), eq(rentalProperties.status, 'active'))),
    getFirstName(userId).catch(() => null),
  ]);
  const active = rows.length;
  const unlinked = rows.filter((r) => !r.fixedAssetId).length;
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  const plural = (n: number) => (n === 1 ? 'y' : 'ies');
  if (active === 0) {
    return {
      greeting: `${your} rental-property register is empty. Add a property and I'll link it to its building asset so depreciation and income track together.`,
      chips: [{ label: 'Add a property', prompt: 'Walk me through adding a rental property.' }],
    };
  }
  if (unlinked > 0) {
    return {
      greeting: `${you} have ${active} active rental propert${plural(active)}, but ${unlinked} ${unlinked === 1 ? "isn't" : "aren't"} linked to a building asset yet. Want to fix that so depreciation tracks correctly?`,
      chips: [{ label: 'Review properties', prompt: 'Show me my rental properties and which ones need a linked asset.' }],
    };
  }
  return {
    greeting: `${you} have ${active} active rental propert${plural(active)}, all linked to their building assets. ✓ Want to review how each is performing?`,
    chips: [{ label: 'Review properties', prompt: 'Show me my rental properties.' }],
  };
}

// ---------------------------------------------------------------------------
// Ledger & close pages
// ---------------------------------------------------------------------------

/** Book Review opener: open audit findings on the books. */
async function bookReviewOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [rows, firstName] = await Promise.all([
    db.select({ severity: bookReviewFindings.severity }).from(bookReviewFindings).where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'))),
    getFirstName(userId).catch(() => null),
  ]);
  const open = rows.length;
  const warn = rows.filter((r) => r.severity === 'warn').length;
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (open === 0) {
    return { greeting: `${your} book review is clean — no open findings. Your books look healthy. ✓`, chips: [] };
  }
  const tail = warn > 0 ? ` (${warn} ${warn === 1 ? 'is a warning' : 'are warnings'} worth a closer look)` : '';
  return {
    greeting: `${you} have ${open} open book-review finding${open === 1 ? '' : 's'}${tail}. Want to work through them together so the books are clean?`,
    chips: [{ label: 'Review findings', prompt: 'Walk me through my open book-review findings, most important first.' }],
  };
}

/** Close the Books opener: completed months not yet locked for the current year. */
async function periodCloseOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const now = new Date();
  const year = now.getFullYear();
  const [rows, firstName] = await Promise.all([
    db.select({ status: accountingPeriods.status }).from(accountingPeriods).where(and(eq(accountingPeriods.organizationId, orgId), eq(accountingPeriods.year, year))),
    getFirstName(userId).catch(() => null),
  ]);
  const settled = rows.filter((r) => r.status === 'closed' || r.status === 'reviewed').length;
  const closed = rows.filter((r) => r.status === 'closed').length;
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  // Months fully elapsed this year (current month is still in progress).
  const closeableThrough = now.getMonth(); // 0-based → count of completed months
  if (closeableThrough === 0) {
    return {
      greeting: `${your} monthly close for ${year} is just getting started. Want me to walk you through closing a month once it's complete?`,
      chips: [{ label: 'How closing works', prompt: 'Walk me through how to close a month.' }],
    };
  }
  const behind = Math.max(0, closeableThrough - settled);
  if (behind > 0) {
    return {
      greeting: `${you} have ${behind} completed month${behind === 1 ? '' : 's'} in ${year} that ${behind === 1 ? "hasn't" : "haven't"} been closed yet. Want to lock ${behind === 1 ? 'it' : 'them'} down together?`,
      chips: [{ label: 'Close the books', prompt: 'Walk me through closing my open monthly periods.' }],
    };
  }
  return { greeting: `${your} monthly close is on track for ${year} — ${closed} month${closed === 1 ? '' : 's'} locked. ✓`, chips: [] };
}

/** Chart of Accounts opener: active accounts + any flagged for review. */
async function chartOfAccountsOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [activeRow, reviewRow, firstName] = await Promise.all([
    db
      .select({ n: count() })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), or(eq(chartOfAccounts.isActive, true), isNull(chartOfAccounts.isActive))))
      .then((r) => r[0]),
    db.select({ n: count() }).from(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.needsReview, true))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const active = Number(activeRow?.n ?? 0);
  const needsReview = Number(reviewRow?.n ?? 0);
  const your = firstName ? `${firstName}, your` : 'Your';
  if (needsReview > 0) {
    return {
      greeting: `${your} chart of accounts has ${active} active account${active === 1 ? '' : 's'}, and ${needsReview} ${needsReview === 1 ? 'needs' : 'need'} review (often AI-created accounts to confirm). Want to clean ${needsReview === 1 ? 'it' : 'them'} up together?`,
      chips: [{ label: 'Review accounts', prompt: 'Show me the accounts that need review in my chart of accounts.' }],
    };
  }
  return {
    greeting: `${your} chart of accounts looks tidy — ${active} active account${active === 1 ? '' : 's'} and nothing flagged for review. ✓ Want to add or reorganize anything?`,
    chips: [{ label: 'Add an account', prompt: 'Help me add a new account to my chart of accounts.' }],
  };
}

/** Journal Entries opener: draft (unposted) entries waiting to post. */
async function journalEntriesOpener(orgId: string, userId: string): Promise<OpenerResponse> {
  const [unpostedRow, firstName] = await Promise.all([
    db.select({ n: count() }).from(journalEntries).where(and(eq(journalEntries.organizationId, orgId), eq(journalEntries.posted, false))).then((r) => r[0]),
    getFirstName(userId).catch(() => null),
  ]);
  const unposted = Number(unpostedRow?.n ?? 0);
  const you = firstName ? `${firstName}, you` : 'You';
  const your = firstName ? `${firstName}, your` : 'Your';
  if (unposted > 0) {
    return {
      greeting: `${you} have ${unposted} draft journal entr${unposted === 1 ? 'y' : 'ies'} that ${unposted === 1 ? "hasn't" : "haven't"} been posted yet. Want to review and post ${unposted === 1 ? 'it' : 'them'} together?`,
      chips: [{ label: 'Review drafts', prompt: 'Show me my unposted journal entries.' }],
    };
  }
  return {
    greeting: `${your} journal entries are all posted — the ledger is current. ✓ Need to record a manual entry?`,
    chips: [{ label: 'New journal entry', prompt: 'Help me record a manual journal entry.' }],
  };
}

/** General Ledger opener: an exploratory page — offer to trace balances/entries. */
async function generalLedgerOpener(userId: string): Promise<OpenerResponse> {
  const firstName = await getFirstName(userId).catch(() => null);
  const your = firstName ? `${firstName}, your` : 'Your';
  return {
    greeting: `${your} general ledger is here — every posted transaction, by account. Want me to help you trace a balance or find a specific entry?`,
    chips: [
      { label: 'Trace an account', prompt: 'Help me trace the activity in a specific account.' },
      { label: 'Find an entry', prompt: 'Help me find a specific transaction in the general ledger.' },
    ],
  };
}

/** Enterprise (firm) opener: the AI staff accountant's welcome. */
async function enterpriseOpener(userId: string): Promise<OpenerResponse> {
  const firstName = await getFirstName(userId).catch(() => null);
  return {
    greeting: `${firstName ? `${firstName}, I'm` : "I'm"} your staff accountant — I can walk you through setting up your firm, go client-by-client through what needs attention, or take you anywhere in your workspace. Where should we start?`,
    chips: [
      { label: 'What needs attention?', prompt: 'Which of my clients need attention right now, and what should I do first?' },
      { label: 'Walk me through setup', prompt: 'Walk me through setting up my firm, step by step.' },
      { label: 'Show my clients', prompt: 'Take me to my clients list.' },
    ],
  };
}

export async function GET(req: Request): Promise<NextResponse<OpenerResponse>> {
  const searchParams = new URL(req.url).searchParams;

  // The floating sidecar asks for a first-open greeting on many protected pages.
  // During production stabilization, that request must not compete with the page
  // for DB pool slots. Lightweight mode returns a safe generic opener without
  // auth/org/action-card reads; the full /ai-chat page can still request the
  // grounded opener by omitting light=1.
  if (searchParams.get('light') === '1') {
    return NextResponse.json({ greeting: null, chips: [] });
  }

  const user = await requireSession();
  const orgId = await getCurrentOrgId();

  const page = searchParams.get('page');
  if (page === 'enterprise') {
    return NextResponse.json(await enterpriseOpener(user.id));
  }

  if (page === 'invoices') {
    return NextResponse.json(await invoicesOpener(orgId, user.id));
  }
  if (page === 'bills') {
    return NextResponse.json(await billsOpener(orgId, user.id));
  }
  if (page === 'transactions') {
    return NextResponse.json(await transactionsOpener(orgId, user.id));
  }
  if (page === 'reports') {
    return NextResponse.json(await reportsOpener(user.id));
  }
  if (page === 'reconciliation') {
    return NextResponse.json(await reconciliationOpener(orgId, user.id));
  }
  if (page === 'form1099') {
    return NextResponse.json(await form1099Opener(orgId, user.id));
  }
  if (page === 'substantiation') {
    return NextResponse.json(await substantiationOpener(orgId, user.id));
  }
  if (page === 'yearend') {
    return NextResponse.json(await yearEndCloseOpener(orgId, user.id));
  }
  if (page === 'imports') {
    return NextResponse.json(await importsOpener(orgId, user.id));
  }
  if (page === 'receipts') {
    return NextResponse.json(await receiptsOpener(orgId, user.id));
  }
  if (page === 'pulse') {
    return NextResponse.json(await pulseOpener(orgId, user.id));
  }
  if (page === 'tasks') {
    return NextResponse.json(await tasksOpener(orgId, user.id));
  }
  if (page === 'organizerdashboard') {
    return NextResponse.json(await organizerDashboardOpener(orgId, user.id));
  }
  if (page === 'payments') {
    return NextResponse.json(await paymentsOpener(orgId, user.id));
  }
  if (page === 'contacts') {
    return NextResponse.json(await contactsOpener(orgId, user.id));
  }
  if (page === 'bankconnections') {
    return NextResponse.json(await bankConnectionsOpener(orgId, user.id));
  }
  if (page === 'qbo') {
    return NextResponse.json(await qboOpener(orgId, user.id));
  }
  if (page === 'plaidfeed') {
    return NextResponse.json(await plaidFeedOpener(orgId, user.id));
  }
  if (page === 'communications') {
    return NextResponse.json(await communicationsOpener(orgId, user.id));
  }
  if (page === 'assets') {
    return NextResponse.json(await assetsOpener(orgId, user.id));
  }
  if (page === 'loans') {
    return NextResponse.json(await loansOpener(orgId, user.id));
  }
  if (page === 'inventory') {
    return NextResponse.json(await inventoryOpener(user.id));
  }
  if (page === 'tags') {
    return NextResponse.json(await tagsOpener(orgId, user.id));
  }
  if (page === 'rentalproperties') {
    return NextResponse.json(await rentalPropertiesOpener(orgId, user.id));
  }
  if (page === 'bookreview') {
    return NextResponse.json(await bookReviewOpener(orgId, user.id));
  }
  if (page === 'periodclose') {
    return NextResponse.json(await periodCloseOpener(orgId, user.id));
  }
  if (page === 'chartofaccounts') {
    return NextResponse.json(await chartOfAccountsOpener(orgId, user.id));
  }
  if (page === 'journalentries') {
    return NextResponse.json(await journalEntriesOpener(orgId, user.id));
  }
  if (page === 'generalledger') {
    return NextResponse.json(await generalLedgerOpener(user.id));
  }

  const ctx = await buildClientContext(orgId).catch(() => null);
  // Only skip the opener for genuinely fresh/empty orgs — an org loaded with
  // real data still gets a grounded opener even if onboarding was never
  // formally marked complete.
  if (!ctx || !hasSubstantiveBooks(ctx)) {
    return NextResponse.json({ greeting: null, chips: [] });
  }

  const firstName = await getFirstName(user.id);
  const chips = deriveChips(ctx);

  const usage: UsageCtx = {
    userId: user.id,
    orgId,
    actor: 'user',
    feature: 'ai-chat',
    metadata: { kind: 'opener' },
  };

  const systemPrompt = `${CFO_PERSONA}

${renderContextBlock(ctx, firstName)}`;

  // Shared cache: the greeting is keyed by a signature of the exact books-state
  // it was generated from (the system prompt). Both /ai-chat and the sidecar hit
  // this route, so they return the SAME greeting until the situation changes —
  // and we skip the model call on the second surface. Chips are deterministic
  // from context, so they're always recomputed (no need to cache).
  const sig = createHash('sha256').update(systemPrompt).digest('hex');
  const [cached] = await db
    .select({ greeting: organizations.aiOpenerGreeting, sig: organizations.aiOpenerSig })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (cached?.greeting && cached.sig === sig) {
    return NextResponse.json({ greeting: cached.greeting, chips });
  }

  const userInstruction =
    'Open the conversation now, proactively — the client just arrived. ' +
    (firstName ? `Greet ${firstName} by their first name. ` : '') +
    'In 2–4 warm, plain-English sentences, lead with the 2–3 most important things that need their attention right now (cite the real numbers from the snapshot), then end with ONE specific question about the single most important item. ' +
    "If their books are in good shape, say so warmly and ask what they'd like to look at. " +
    'No bullet lists, no markdown — just speak to them.';

  let greeting: string | null = null;
  try {
    const res = await chatCompletion(usage, {
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInstruction },
      ],
    });
    greeting = res.choices[0]?.message?.content?.trim() || null;
  } catch {
    greeting = null;
  }

  // Store so the other surface (and subsequent loads) reuse the same greeting.
  if (greeting) {
    await db
      .update(organizations)
      .set({ aiOpenerGreeting: greeting, aiOpenerSig: sig, aiOpenerAt: new Date().toISOString() })
      .where(eq(organizations.id, orgId))
      .catch(() => {});
  }

  return NextResponse.json({ greeting, chips });
}
