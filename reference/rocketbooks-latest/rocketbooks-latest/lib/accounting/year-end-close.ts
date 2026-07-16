import 'server-only';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, journalEntries, bookReviewFindings, yearEndCloseItems } from '@/db/schema/schema';
import { loadForm1099Summary } from '@/lib/reports/form-1099-data';
import { loadSalesTaxLiability } from '@/lib/reports/sales-tax-data';

export type CloseStatus = 'done' | 'attention' | 'info';

export interface CloseItem {
  key: string;
  title: string;
  description: string;
  kind: 'auto' | 'manual';
  status: CloseStatus;
  detail: string;
  href?: string;
  manualDone?: boolean;
}

export interface YearEndCloseData {
  year: number;
  items: CloseItem[];
  done: number;
  total: number;
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const MANUAL_ITEMS: { key: string; title: string; description: string; href?: string }[] = [
  { key: 'reconcile', title: 'Reconcile all accounts', description: 'Reconcile every bank & credit card account through year-end.', href: '/reconciliation' },
  { key: 'depreciation', title: 'Record depreciation & review fixed assets', description: 'Post depreciation for the year and confirm the fixed-asset register.', href: '/assets' },
  { key: 'beginning_balances', title: 'Confirm opening balances', description: 'Verify the beginning-of-year balances tie to last year’s ending balances.' },
  { key: 'client_approval', title: 'Send books to client for approval', description: 'Share the finalized financials with the client and get sign-off.' },
];

export async function loadYearEndClose(orgId: string, year: number): Promise<YearEndCloseData> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const [txnRow, adjRow, findingsRow, f1099, salesTax, manualRows] = await Promise.all([
    db
      .select({
        uncategorized: sql<string>`COUNT(*) FILTER (WHERE ${transactions.categoryAccountId} IS NULL)`,
        unreviewed: sql<string>`COUNT(*) FILTER (WHERE ${transactions.reviewed} = false)`,
      })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), gte(transactions.date, from), lte(transactions.date, to))),
    db
      .select({ n: sql<string>`COUNT(*)` })
      .from(journalEntries)
      .where(and(eq(journalEntries.organizationId, orgId), eq(journalEntries.isAdjusting, true), gte(journalEntries.date, from), lte(journalEntries.date, to))),
    db
      .select({ n: sql<string>`COUNT(*)` })
      .from(bookReviewFindings)
      .where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'))),
    loadForm1099Summary(orgId, year),
    loadSalesTaxLiability(orgId, from, to, 'accrual'),
    db
      .select({ itemKey: yearEndCloseItems.itemKey, done: yearEndCloseItems.done })
      .from(yearEndCloseItems)
      .where(and(eq(yearEndCloseItems.organizationId, orgId), eq(yearEndCloseItems.year, year))),
  ]);

  const uncategorized = Number(txnRow[0]?.uncategorized ?? 0);
  const unreviewed = Number(txnRow[0]?.unreviewed ?? 0);
  const adjusting = Number(adjRow[0]?.n ?? 0);
  const openFindings = Number(findingsRow[0]?.n ?? 0);
  const unconfirmed1099 = f1099.rows.filter((r) => r.meetsThreshold && !r.eligible).length;
  const manualDone = new Map(manualRows.map((m) => [m.itemKey, m.done]));

  const items: CloseItem[] = [];

  // --- Auto items (status derived live) ---
  items.push({
    key: 'categorize',
    title: 'Categorize & review all transactions',
    description: 'Every transaction for the year is categorized and reviewed.',
    kind: 'auto',
    status: uncategorized === 0 && unreviewed === 0 ? 'done' : 'attention',
    detail: uncategorized === 0 && unreviewed === 0 ? 'All clear' : `${uncategorized} uncategorized · ${unreviewed} to review`,
    href: '/transactions?filter=to_review',
  });

  items.push({
    key: 'book_review',
    title: 'Clear book-review findings',
    description: 'Resolve open audit findings (duplicates, anomalies, integrity).',
    kind: 'auto',
    status: openFindings === 0 ? 'done' : 'attention',
    detail: openFindings === 0 ? 'No open findings' : `${openFindings} open finding${openFindings === 1 ? '' : 's'}`,
    href: '/book-review',
  });

  items.push({
    key: 'adjusting',
    title: 'Post adjusting entries',
    description: 'Accruals, deferrals, and other adjusting journal entries for the year.',
    kind: 'auto',
    status: 'info',
    detail: `${adjusting} adjusting ${adjusting === 1 ? 'entry' : 'entries'} posted`,
    href: '/reports/trial-balance?view=adjusted',
  });

  items.push({
    key: 'confirm_1099',
    title: 'Confirm 1099 vendors',
    description: 'Review vendors paid $600+ and confirm who needs a 1099-NEC.',
    kind: 'auto',
    status: unconfirmed1099 === 0 ? 'done' : 'attention',
    detail: unconfirmed1099 === 0 ? 'All reviewed' : `${unconfirmed1099} vendor${unconfirmed1099 === 1 ? '' : 's'} to review`,
    href: '/reports/form-1099',
  });

  items.push({
    key: 'collect_w9',
    title: 'Collect W-9s',
    description: 'Every 1099 vendor has a W-9 / TIN on file.',
    kind: 'auto',
    status: f1099.totals.missingPaperwork === 0 ? 'done' : 'attention',
    detail: f1099.totals.missingPaperwork === 0 ? 'All on file' : `${f1099.totals.missingPaperwork} missing W-9 / TIN`,
    href: '/reports/form-1099',
  });

  if (salesTax.hasAccount) {
    const owed = salesTax.endingBalance > 0.005;
    items.push({
      key: 'sales_tax',
      title: 'Remit sales tax',
      description: 'Sales tax collected has been remitted to the authority.',
      kind: 'auto',
      status: owed ? 'attention' : 'done',
      detail: owed ? `${money(salesTax.endingBalance)} still owed` : 'Nothing owed',
      href: '/reports/sales-tax',
    });
  }

  // --- Manual items (checked off by the accountant) ---
  for (const m of MANUAL_ITEMS) {
    const done = manualDone.get(m.key) ?? false;
    items.push({
      key: m.key,
      title: m.title,
      description: m.description,
      kind: 'manual',
      status: done ? 'done' : 'attention',
      detail: done ? 'Marked complete' : 'Not done',
      href: m.href,
      manualDone: done,
    });
  }

  // Progress excludes pure-info items.
  const gating = items.filter((i) => i.status !== 'info');
  const done = gating.filter((i) => i.status === 'done').length;

  return { year, items, done, total: gating.length };
}
