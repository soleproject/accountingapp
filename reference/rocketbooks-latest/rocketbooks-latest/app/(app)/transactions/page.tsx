import { Fragment, Suspense } from 'react';
import Link from 'next/link';
import { eq, desc, count, sql, and, isNull, ilike, or, gte, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { transactions, contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getImpersonatedUserId } from '@/lib/auth/impersonate';
import { cookies } from 'next/headers';
import { requirePermission, hasAnyPermission } from '@/lib/auth/permissions';
import { getPfcMapping, pfcQuestion, type PfcClassification, type PfcQuestionTemplate } from '@/lib/accounting/pfc-coa-mapping';
import { BulkBar } from './_components/BulkBar';
import { ReviewedToggle } from './_components/ReviewedToggle';
import { RestoreDuplicateButton } from './_components/RestoreDuplicateButton';
import { FiltersPanel } from './_components/FiltersPanel';
import { AssistantPageRegistration } from './_components/AssistantPageRegistration';
import { GuidedTriage, type GuideGroup } from './_components/GuidedTriage';
import { AddTransactionMenu } from './_components/AddTransactionMenu';
import { MoreMenu } from './_components/MoreMenu';
import { TransactionsStepper, type StepperStep } from './_components/TransactionsStepper';
import { EvidenceDrawer } from './_components/EvidenceDrawer';
import { RequestClientReviewButton } from './_components/RequestClientReviewButton';
import { StartGuidedReviewButton } from './_components/StartGuidedReviewButton';
import { ReviewStartAsk } from './_components/ReviewStartAsk';
import { TransactionsLandingClient } from './_components/TransactionsLandingClient';
import { loadTransactionsLanding, type TransactionLandingRow } from './_lib/loadTransactionsLanding';
import { timeDb } from '@/lib/perf/db-timing';

// transactions joins chart_of_accounts twice: once for the source bank account
// (account_id) and once for the categorization (category_account_id). Drizzle
// requires distinct aliases for repeated joins on the same table.
const bankAccount = alias(chartOfAccounts, 'bank_account');
const categoryAccount = alias(chartOfAccounts, 'category_account');

const PAGE_SIZE = 50;
// Filter semantics:
//   - to_review : reviewed = false (or null) — the queue of rows the client must look at.
//                 PFC-driven promotion auto-sets reviewed=true for confidently classified
//                 rows; transfers / uncategorized / anything needing human eyes lands here.
//   - reviewed  : reviewed = true — auto-classified or manually confirmed.
//   - uncategorized : no category_account_id assigned at all.
//   - unposted  : no journal_entry_id (separate from review status — a row can be reviewed
//                 but not yet posted to the GL).
const VALID_FILTERS = ['all', 'to_review', 'to_verify', 'reviewed', 'uncategorized', 'unposted', 'removed_duplicates'] as const;
type Filter = (typeof VALID_FILTERS)[number];
// Review-status filtering moved from pills to toggles in the filter panel
// (Reviewed / Unreviewed). uncategorized/unposted remain valid URL filters.

// Sortable columns. Each maps to a sql expression in `sortExprs` below.
// Whitelisted to keep query params from injecting arbitrary order-by SQL.
const VALID_SORTS = ['date', 'description', 'contact', 'account', 'category', 'amount'] as const;
type SortColumn = (typeof VALID_SORTS)[number];
type SortDir = 'asc' | 'desc';

interface PageProps {
  searchParams: Promise<{
    page?: string;
    filter?: string;
    q?: string;
    accountId?: string;
    categoryId?: string;
    contactId?: string;
    start?: string;
    end?: string;
    sort?: string;
    dir?: string;
    /** "1" turns on the spotlight + AI walkthrough on the to_review queue. */
    guide?: string;
    /** 0-based index of the active group within the on-page groups list. */
    guideIndex?: string;
    /** "pro" turns on the accountant lens: confidence column + evidence drawer. */
    view?: string;
    /** "1" shows the Account + JE columns (Transaction Details toggle, default off). */
    details?: string;
    /** "0" hides deposit / withdrawal rows respectively (both default on). */
    deposits?: string;
    withdrawals?: string;
    /** "0" hides reviewed / unreviewed rows respectively (both default on). */
    reviewed?: string;
    unreviewed?: string;
  }>;
}

/** Validate a YYYY-MM-DD date string. Loose — Postgres date column will hard-validate on cast. */
function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const TRANSACTION_VIEW_PARAMS = [
  'page', 'filter', 'q', 'accountId', 'categoryId', 'contactId', 'start', 'end',
  'sort', 'dir', 'guide', 'guideIndex', 'view', 'details', 'deposits', 'withdrawals',
  'reviewed', 'unreviewed',
] as const;

export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const defaultLanding = !TRANSACTION_VIEW_PARAMS.some((key) => sp[key] != null && sp[key] !== '');
  if (defaultLanding) {
    const organizationId = await getCurrentOrgId();
    const initialRows = await loadTransactionsLanding(organizationId).catch(() => null);
    return <TransactionsLandingShell organizationId={organizationId} initialRows={initialRows} />;
  }
  return (
    <Suspense fallback={<TransactionsSkeleton />}>
      <TransactionsData searchParams={Promise.resolve(sp)} />
    </Suspense>
  );
}

function TransactionsLandingShell({ organizationId, initialRows }: { organizationId: string; initialRows: TransactionLandingRow[] | null }) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Recent transactions</p>
        </div>
        <div className="flex items-center gap-2">
          <MoreMenu exportHref="/api/transactions/export" />
          <AddTransactionMenu />
        </div>
      </header>
      <FiltersPanel
        selected={{ q: '', accountId: '', categoryId: '', contactId: '', start: '', end: '' }}
        showDetails={false}
        showDeposits={true}
        showWithdrawals={true}
        showReviewed={true}
        showUnreviewed={true}
        preserve={{}}
      >
        <form className="flex items-center gap-2" method="get">
          <input
            type="text"
            name="q"
            placeholder="Search…"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
            Search
          </button>
        </form>
      </FiltersPanel>
      <BulkBar />
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <TransactionsLandingClient key={organizationId} initialRows={initialRows} />
      </div>
    </div>
  );
}

async function TransactionsData({ searchParams }: PageProps) {
  const permissionPromise = requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;
  const { page: pageStr, filter: filterStr, q, guide: guideStr, guideIndex: guideIndexStr } = sp;
  const guideMode = (filterStr === 'to_review' || filterStr === 'to_verify') && guideStr === '1';
  // Accountant lens — adds a confidence column + provenance drawer over the
  // same data the owner-facing queue shows. Dual-lens toggle, no new table.
  // Gated to accounting professionals: the explicit accountant-review key, or
  // any enterprise/firm user (allow_all super-admins pass too). Self-serve
  // owners on an accounting tier set don't carry these, so they never see it —
  // and can't force it via ?view=pro.
  const wantsProView = sp.view === 'pro';
  const canAccountantReview = wantsProView
    ? await hasAnyPermission([
        'accounting.transactions.accountant_review',
        'enterprise.dashboard.view',
        'enterprise.clients.view',
      ])
    : false;
  const proView = canAccountantReview;
  // "Request client input" only makes sense from an Open Books / impersonation
  // view — the pro is in the client's books and asking THAT client. Hide it
  // otherwise (e.g. a pro on their own org, or the client themselves).
  const isImpersonating = canAccountantReview ? (await getImpersonatedUserId()) !== null : false;
  // Transaction Details toggle (default OFF): hides the Account + JE columns to
  // keep the table focused. Remembered in a cookie across visits; an explicit
  // ?details=0/1 (from the toggle) overrides it for the current navigation so
  // the change applies immediately.
  const cookieStore = await cookies();
  const showDetails = sp.details != null ? sp.details === '1' : cookieStore.get('rs_txn_details')?.value === '1';
  // Deposit / Withdrawal type filters — both default ON (show), so only an
  // explicit '0' (param or remembered cookie) turns one off.
  const showDeposits = sp.deposits != null ? sp.deposits === '1' : cookieStore.get('rs_txn_deposits')?.value !== '0';
  const showWithdrawals = sp.withdrawals != null ? sp.withdrawals === '1' : cookieStore.get('rs_txn_withdrawals')?.value !== '0';
  // Reviewed / Unreviewed status toggles — both default ON (show). They replace
  // the old All/Unreviewed/Reviewed pills; the effective `filter` is derived from
  // them below (unreviewed-only → the to_review triage view, as before).
  const showReviewed = sp.reviewed != null ? sp.reviewed === '1' : cookieStore.get('rs_txn_reviewed')?.value !== '0';
  const showUnreviewed = sp.unreviewed != null ? sp.unreviewed === '1' : cookieStore.get('rs_txn_unreviewed')?.value !== '0';
  // Deposit guided review = guided mode scoped to deposits only (deposits on,
  // withdrawals off). Swaps the AI seed to "what is this deposit?" + surfaces
  // the six deposit chips in the sidecar.
  const guideDeposits = guideMode && showDeposits && !showWithdrawals;
  // "Review AI Categorized" guided verify = guided mode over filter=to_verify
  // (AI-categorized, human-unverified). Seed becomes "I categorized X as Y — ok?".
  const guideVerify = guideMode && filterStr === 'to_verify';
  const requestedGuideIndex = Math.max(0, parseInt(guideIndexStr ?? '0', 10) || 0);
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  // Effective review filter. Guided review (to_review+guide) and the
  // uncategorized/unposted deep-links keep their explicit ?filter; otherwise the
  // two review-status toggles drive it. Both off → match nothing (handled below).
  const explicitFilter = (VALID_FILTERS as readonly string[]).includes(filterStr ?? '') ? (filterStr as Filter) : null;
  const togglesDriveFilter =
    !guideMode &&
    explicitFilter !== 'uncategorized' &&
    explicitFilter !== 'unposted' &&
    explicitFilter !== 'to_verify';
  const noReviewStatus = togglesDriveFilter && !showReviewed && !showUnreviewed;
  let filter: Filter;
  if (!togglesDriveFilter) {
    filter = explicitFilter ?? 'all';
  } else if (showUnreviewed && !showReviewed) {
    filter = 'to_review';
  } else if (showReviewed && !showUnreviewed) {
    filter = 'reviewed';
  } else {
    filter = 'all';
  }
  const accountIdFilter = sp.accountId?.trim() || null;
  const categoryIdFilter = sp.categoryId?.trim() || null;
  const contactIdFilter = sp.contactId?.trim() || null;
  const startDate = sp.start && isValidIsoDate(sp.start) ? sp.start : null;
  const endDate = sp.end && isValidIsoDate(sp.end) ? sp.end : null;
  const sortColumn: SortColumn = (VALID_SORTS as readonly string[]).includes(sp.sort ?? '')
    ? (sp.sort as SortColumn)
    : 'date';
  const sortDir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';

  const conditions = [eq(transactions.organizationId, orgId)];
  // Cross-source dedupe bucket. The "Removed duplicates" view shows ONLY
  // quarantined rows; every other view hides them — they carry zero GL impact
  // and aren't part of the real ledger.
  if (filter === 'removed_duplicates') conditions.push(eq(transactions.dedupeState, 'duplicate'));
  else conditions.push(sql`${transactions.dedupeState} <> 'duplicate'`);
  if (filter === 'uncategorized') conditions.push(isNull(transactions.categoryAccountId));
  if (filter === 'unposted') conditions.push(isNull(transactions.journalEntryId));
  if (filter === 'reviewed') conditions.push(eq(transactions.reviewed, true));
  if (filter === 'to_review') {
    // reviewed is nullable in the schema (default=false). Both false and null
    // count as "not yet reviewed".
    conditions.push(or(eq(transactions.reviewed, false), isNull(transactions.reviewed))!);
  }
  if (filter === 'to_verify') {
    // "Review AI Categorized": AI-categorized (reviewed=true) but not yet
    // human-verified (verified=false) — the guided verify queue.
    conditions.push(eq(transactions.reviewed, true));
    conditions.push(eq(transactions.verified, false));
  }
  // Deposit/Withdrawal type toggles. Both on → no filter; one on → that type
  // only; both off → match nothing.
  if (showDeposits && !showWithdrawals) conditions.push(eq(transactions.type, 'deposit'));
  else if (!showDeposits && showWithdrawals) conditions.push(eq(transactions.type, 'withdrawal'));
  else if (!showDeposits && !showWithdrawals) conditions.push(sql`1 = 0`);
  // Both review-status toggles off → show nothing.
  if (noReviewStatus) conditions.push(sql`1 = 0`);

  if (q && q.trim()) {
    const search = `%${q.trim()}%`;
    conditions.push(
      or(
        ilike(transactions.description, search),
        ilike(transactions.bankDescription, search),
        ilike(transactions.userDescription, search),
      )!,
    );
  }
  if (accountIdFilter) conditions.push(eq(transactions.accountId, accountIdFilter));
  if (categoryIdFilter) conditions.push(eq(transactions.categoryAccountId, categoryIdFilter));
  if (contactIdFilter) conditions.push(eq(transactions.contactId, contactIdFilter));
  if (startDate) conditions.push(gte(transactions.date, startDate));
  if (endDate) conditions.push(lte(transactions.date, endDate));
  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  // Sort expressions per column. NULLS LAST on every sort so nulls don't
  // dominate the page. Joined columns sort by the joined alias, with a
  // fallback to date+id for stable ordering on ties.
  const sortColExpr =
    sortColumn === 'description'
      ? sql`COALESCE(${transactions.bankDescription}, ${transactions.description})`
      : sortColumn === 'contact'
      ? sql`${contacts.contactName}`
      : sortColumn === 'account'
      ? sql`${bankAccount.accountName}`
      : sortColumn === 'category'
      ? sql`${categoryAccount.accountName}`
      : sortColumn === 'amount'
      ? sql`${transactions.amount}`
      : sql`${transactions.date}`;
  const userSortExpr =
    sortDir === 'asc'
      ? sql`${sortColExpr} ASC NULLS LAST`
      : sql`${sortColExpr} DESC NULLS LAST`;
  // On the to_review queue we group rows by contact so the user can plow
  // through one merchant at a time. Contact name is the primary sort; the
  // user's chosen column becomes the within-group secondary sort. Contact-less
  // rows fall to the bottom (NULLS LAST). Other filter views use the user's
  // sort directly.
  const orderBy =
    filter === 'to_verify'
      ? // Verify groups by contact THEN category, so each (contact, category) block
        // is contiguous for the header + spotlight.
        [
          sql`${contacts.contactName} ASC NULLS LAST`,
          sql`${categoryAccount.accountName} ASC NULLS LAST`,
          userSortExpr,
          desc(transactions.id),
        ]
      : filter === 'to_review'
        ? [
            sql`${contacts.contactName} ASC NULLS LAST`,
            userSortExpr,
            desc(transactions.id),
          ]
        : [userSortExpr, desc(transactions.id)];

  const timingContext = { route: '/transactions', filter, sort: sortColumn, dir: sortDir, page };
  const defaultLandingView =
    filter === 'all' &&
    page === 1 &&
    !q?.trim() &&
    !accountIdFilter &&
    !categoryIdFilter &&
    !contactIdFilter &&
    !startDate &&
    !endDate &&
    showDeposits &&
    showWithdrawals &&
    showReviewed &&
    showUnreviewed &&
    !guideMode;
  // Keep the default /transactions landing page under the SaaS UX bar: it only
  // needs the visible row slice. Exact total/review counters are deferred from
  // this first paint; filtered and guided review views still keep exact counts.
  const rows = await timeDb(
    'transactions.pageRows',
    () =>
      db
        .select({
          id: transactions.id,
          reviewed: transactions.reviewed,
          verified: transactions.verified,
          date: transactions.date,
          description: transactions.description,
          bankDescription: transactions.bankDescription,
          amount: transactions.amount,
          type: transactions.type,
          journalEntryId: transactions.journalEntryId,
          categoryAccountId: transactions.categoryAccountId,
          createdAt: transactions.createdAt,
          aiConfidence: transactions.aiConfidence,
          aiSource: transactions.aiSource,
          contactName: contacts.contactName,
          bankAccountName: bankAccount.accountName,
          categoryAccountName: categoryAccount.accountName,
          // PFCv2 detailed code is only needed for the review/verify views.
          pfcDetailed: sql<string | null>`case when ${filter === 'to_review' || filter === 'to_verify'}::boolean then (
            SELECT prt.raw_json->'personal_finance_category'->>'detailed'
            FROM plaid_raw_transactions prt
            WHERE ${transactions.reference} LIKE 'plaid:%'
              AND prt.plaid_transaction_id = substring(${transactions.reference} FROM 7)
            LIMIT 1
          ) else null end`,
          splitCount: sql<number>`case when ${!defaultLandingView}::boolean then (
            SELECT COUNT(*)::int FROM transaction_splits ts
            WHERE ts.transaction_id = ${transactions.id}
          ) else 0 end`,
          hasReceiptMatch: sql<boolean>`case when ${!defaultLandingView}::boolean then EXISTS (
            SELECT 1 FROM receipt_match_applications rma
            WHERE rma.transaction_id = ${transactions.id}
              AND rma.reversed_at IS NULL
          ) else false end`,
        })
        .from(transactions)
        .leftJoin(contacts, eq(transactions.contactId, contacts.id))
        .leftJoin(bankAccount, eq(transactions.accountId, bankAccount.id))
        .leftJoin(categoryAccount, eq(transactions.categoryAccountId, categoryAccount.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(defaultLandingView ? 10 : PAGE_SIZE)
        .offset(offset),
    timingContext,
  );

  await permissionPromise;

  const counts = defaultLandingView
    ? { total: [{ n: rows.length }], summary: [{ unposted: 0, toReview: 0, categorizing: 0, depositsToReview: 0, aiToVerify: 0, withdrawalsToReview: 0 }] }
    : await (async () => {
        const [[total], [summaryCounts]] = await Promise.all([
          timeDb('transactions.totalCount', () => db.select({ n: count() }).from(transactions).where(where), timingContext),
          timeDb(
            'transactions.summaryCounts',
            () =>
              db
                .select({
                  unposted: sql<number>`count(*) filter (where ${transactions.journalEntryId} is null)::int`,
                  toReview: sql<number>`count(*) filter (where (${transactions.reviewed} = false or ${transactions.reviewed} is null))::int`,
                  categorizing: sql<number>`count(*) filter (where ${transactions.categoryAccountId} is null and ${transactions.journalEntryId} is null and ${transactions.createdAt} > now() - interval '15 minutes')::int`,
                  depositsToReview: sql<number>`count(*) filter (where ${transactions.type} = 'deposit' and (${transactions.reviewed} = false or ${transactions.reviewed} is null))::int`,
                  aiToVerify: sql<number>`count(*) filter (where ${transactions.reviewed} = true and ${transactions.verified} = false)::int`,
                  withdrawalsToReview: sql<number>`count(*) filter (where ${transactions.type} = 'withdrawal' and (${transactions.reviewed} = false or ${transactions.reviewed} is null))::int`,
                })
                .from(transactions)
                .where(eq(transactions.organizationId, orgId)),
            timingContext,
          ),
        ]);
        return { total: [total], summary: [summaryCounts] };
      })();
  const [total] = counts.total;
  const [summaryCounts] = counts.summary;

  const totalCount = total?.n ?? 0;
  const uncategorizedCount = Number(summaryCounts?.unposted ?? 0);
  const toReviewCount = Number(summaryCounts?.toReview ?? 0);
  const categorizingCount = Number(summaryCounts?.categorizing ?? 0);
  const depositsToReview = Number(summaryCounts?.depositsToReview ?? 0);
  const aiToVerify = Number(summaryCounts?.aiToVerify ?? 0);
  // Uncategorized SPENDING = unreviewed withdrawals only (deposits go to the
  // Review Deposits flow, so they're not double-reviewed here).
  const uncategorizedSpending = Number(summaryCounts?.withdrawalsToReview ?? 0);
  // Which review VIEW is the user on (NOT in guide mode)? Drives the AI's
  // "want to start?" offer and the view's Start-guided-review button.
  const reviewKind: 'deposits' | 'ai_categorized' | 'uncategorized' | null = guideMode
    ? null
    : filter === 'to_verify'
      ? 'ai_categorized'
      : filter === 'to_review' && showDeposits && !showWithdrawals
        ? 'deposits'
        : filter === 'to_review'
          ? 'uncategorized'
          : null;
  const reviewCount =
    reviewKind === 'deposits'
      ? depositsToReview
      : reviewKind === 'ai_categorized'
        ? aiToVerify
        : reviewKind === 'uncategorized'
          ? uncategorizedSpending
          : 0;
  // Top-of-page review stepper. Each step links to its VIEW (the filtered list) —
  // NOT guide=1. Landing on the view, the AI offers to start (ReviewStartAsk) and
  // the view's own "Start guided review" button launches the guided flow.
  const stepperSteps: StepperStep[] = [
    {
      id: 'deposits',
      label: 'Review Deposits',
      count: depositsToReview,
      detail: depositsToReview > 0 ? `${depositsToReview} to review` : 'All reviewed',
      status: depositsToReview > 0 ? 'in_progress' : 'done',
      href: '/transactions?deposits=1&withdrawals=0&reviewed=0&unreviewed=1&filter=to_review',
    },
    {
      id: 'ai',
      label: 'Review AI Categorized',
      count: aiToVerify,
      detail: aiToVerify > 0 ? `${aiToVerify} to review` : 'All reviewed',
      status: aiToVerify > 0 ? 'in_progress' : 'done',
      href: '/transactions?filter=to_verify&deposits=1&withdrawals=1',
    },
    {
      id: 'uncat',
      label: 'Uncategorized Spending',
      count: uncategorizedSpending,
      detail: uncategorizedSpending > 0 ? `${uncategorizedSpending} to review` : 'All reviewed',
      status: uncategorizedSpending > 0 ? 'in_progress' : 'done',
      href: '/transactions?reviewed=0&unreviewed=1&deposits=0&withdrawals=1&filter=to_review',
    },
  ];

  // Group key for guided review. Verify mode splits a contact BY CATEGORY so each
  // confirmation is a clean single-category "I categorized X as Y"; the other modes
  // group by contact only.
  const rowGroupKey = (r: { contactName: string | null; categoryAccountId: string | null }): string =>
    guideVerify ? `${r.contactName ?? '__none__'}::${r.categoryAccountId ?? ''}` : r.contactName ?? '__none__';

  // Group the visible rows for guided triage. Order preserved = the same order
  // they appear in the table, so groups[0] is whatever shows first under the sort.
  const guideGroups: GuideGroup[] = guideMode
    ? (() => {
        const byKey = new Map<string, GuideGroup>();
        for (const r of rows) {
          const key = rowGroupKey(r);
          const rc = r.categoryAccountName ?? null;
          let g = byKey.get(key);
          if (!g) {
            g = {
              key,
              contactName: r.contactName ?? '(No contact)',
              count: 0,
              totalAmount: 0,
              sampleDescription: r.bankDescription ?? r.description ?? null,
              // Shared category for the group (verify mode says "I categorized X
              // as Y"). null = the group spans multiple categories.
              categoryName: rc,
              transactionIds: [],
            };
            byKey.set(key, g);
          } else if (g.categoryName !== rc) {
            g.categoryName = null;
          }
          g.count += 1;
          g.totalAmount += r.amount ?? 0;
          g.transactionIds.push(r.id);
        }
        return Array.from(byKey.values());
      })()
    : [];
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  // Cutoff for the "Categorizing…" row state — computed once per request
  // (server-side render). Anything created within this window with no JE/
  // category yet is still in the auto-categorize gap; older than this and
  // the stuck-pending-fallback job will have parked it on Uncategorized.
  // eslint-disable-next-line react-hooks/purity -- server component; per-request "now" is fine
  const stuckCutoffMs = Date.now() - 15 * 60_000;
  const exportHref = `/api/transactions/export${q ? `?q=${encodeURIComponent(q)}` : ''}`;

  // Account/category filter options are intentionally not loaded on the SSR
  // path; FiltersPanel and BulkBar fetch bounded options from the guarded lazy
  // endpoint only when a user opens filters or selects rows.

  // Helper to build URLs that preserve all current filter/sort/search params
  // except whichever one is being changed. Used by sortable headers and
  // pagination so clicking around doesn't drop the user's other filters.
  const allParams = {
    filter: filter !== 'all' ? filter : undefined,
    q: q || undefined,
    accountId: accountIdFilter ?? undefined,
    categoryId: categoryIdFilter ?? undefined,
    contactId: contactIdFilter ?? undefined,
    start: startDate ?? undefined,
    end: endDate ?? undefined,
    sort: sortColumn !== 'date' || sortDir !== 'desc' ? sortColumn : undefined,
    dir: sortDir !== 'desc' ? sortDir : undefined,
    guide: guideMode ? '1' : undefined,
    guideIndex: undefined as string | undefined,
    view: proView ? 'pro' : undefined,
    details: showDetails ? '1' : undefined,
    deposits: showDeposits ? undefined : '0',
    withdrawals: showWithdrawals ? undefined : '0',
    reviewed: showReviewed ? undefined : '0',
    unreviewed: showUnreviewed ? undefined : '0',
  } as const;
  const buildHref = (overrides: Partial<Record<keyof typeof allParams | 'page', string | undefined>>): string => {
    const merged = { ...allParams, ...overrides } as Record<string, string | undefined>;
    const parts = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
    return parts.length === 0 ? '?' : `?${parts.join('&')}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <AssistantPageRegistration
        state={{
          page,
          filter,
          q: q ?? null,
          accountId: accountIdFilter,
          categoryId: categoryIdFilter,
          contactId: contactIdFilter,
          start: startDate,
          end: endDate,
          sort: sortColumn,
          dir: sortDir,
          totalMatching: totalCount,
          uncategorizedCount,
          reviewCounts: { deposits: depositsToReview, aiCategorized: aiToVerify, uncategorized: uncategorizedSpending },
          visibleTransactionIds: rows.map((r) => r.id),
          guide: (() => {
            if (!guideMode || guideGroups.length === 0) return null;
            const idx = Math.min(requestedGuideIndex, guideGroups.length - 1);
            const g = guideGroups[idx];
            return {
              kind: guideVerify
                ? ('verify' as const)
                : guideDeposits
                  ? ('deposits' as const)
                  : ('triage' as const),
              contactName: g.contactName,
              count: g.count,
              totalAmount: g.totalAmount,
              sampleDescription: g.sampleDescription,
              categoryName: g.categoryName ?? null,
              transactionIds: g.transactionIds,
              remainingGroups: guideGroups.length,
            };
          })(),
        }}
      />
      {reviewKind && !guideMode && reviewCount > 0 && (
        // On a review VIEW (not yet guiding): the AI offers to start the walkthrough.
        <ReviewStartAsk reviewKind={reviewKind} count={reviewCount} />
      )}
      {guideMode && (
        <GuidedTriage
          groups={guideGroups}
          activeIndex={Math.min(requestedGuideIndex, Math.max(0, guideGroups.length - 1))}
          mode={guideVerify ? 'verify' : guideDeposits ? 'deposits' : 'triage'}
        />
      )}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {totalCount.toLocaleString()} matching · Page {page} of {pageCount}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MoreMenu
            exportHref={exportHref}
            rulesHref={canAccountantReview ? '/transactions/rules' : undefined}
            accountantViewHref={
              canAccountantReview ? buildHref({ view: proView ? undefined : 'pro', page: undefined }) : undefined
            }
            accountantViewOn={proView}
            removedDuplicatesHref={buildHref({ filter: 'removed_duplicates', page: undefined })}
          />
          <AddTransactionMenu />
        </div>
      </header>

      {!guideMode && <TransactionsStepper steps={stepperSteps} />}

      <FiltersPanel
        selected={{
          q: q ?? '',
          accountId: accountIdFilter ?? '',
          categoryId: categoryIdFilter ?? '',
          contactId: contactIdFilter ?? '',
          start: startDate ?? '',
          end: endDate ?? '',
        }}
        // Hidden inputs preserve filter pills / sort when the user
        // submits the filter form.
        showDetails={showDetails}
        showDeposits={showDeposits}
        showWithdrawals={showWithdrawals}
        showReviewed={showReviewed}
        showUnreviewed={showUnreviewed}
        preserve={{
          filter: filter !== 'all' ? filter : undefined,
          sort: sortColumn !== 'date' || sortDir !== 'desc' ? sortColumn : undefined,
          dir: sortDir !== 'desc' ? sortDir : undefined,
          view: proView ? 'pro' : undefined,
          details: showDetails ? '1' : undefined,
          deposits: showDeposits ? undefined : '0',
          withdrawals: showWithdrawals ? undefined : '0',
          reviewed: showReviewed ? undefined : '0',
          unreviewed: showUnreviewed ? undefined : '0',
        }}
      >
        <form className="flex items-center gap-2" method="get">
          {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
          {proView && <input type="hidden" name="view" value="pro" />}
          <input
            type="text"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search…"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
            Search
          </button>
        </form>
        {(filter === 'all' || filter === 'to_review' || filter === 'to_verify' || filter === 'reviewed') &&
          !guideMode &&
          categorizingCount === 0 &&
          (reviewKind ? reviewCount > 0 : depositsToReview + aiToVerify + uncategorizedSpending > 0) && (
            // On a review VIEW → starts THAT view's guided flow. On the main page
            // (reviewKind null) → opens the assistant picker (deposits / AI / uncat).
            <StartGuidedReviewButton
              reviewKind={reviewKind}
              deposits={depositsToReview}
              aiCategorized={aiToVerify}
              uncategorized={uncategorizedSpending}
            />
          )}
        {canAccountantReview && isImpersonating && !guideMode && toReviewCount > 0 && (filter === 'all' || filter === 'to_review') && (
          <RequestClientReviewButton count={toReviewCount} />
        )}
      </FiltersPanel>

      <BulkBar />

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="w-10 px-4 py-2"></th>
              <SortableTh col="date" current={sortColumn} dir={sortDir} buildHref={buildHref}>Date</SortableTh>
              <SortableTh col="description" current={sortColumn} dir={sortDir} buildHref={buildHref}>Description</SortableTh>
              <SortableTh col="contact" current={sortColumn} dir={sortDir} buildHref={buildHref}>Contact</SortableTh>
              {showDetails && <SortableTh col="account" current={sortColumn} dir={sortDir} buildHref={buildHref}>Account</SortableTh>}
              <SortableTh col="category" current={sortColumn} dir={sortDir} buildHref={buildHref}>Category</SortableTh>
              {proView && <Th>Confidence</Th>}
              {filter === 'to_review' && <Th>Why review</Th>}
              {showDetails && <Th>JE</Th>}
              <SortableTh col="amount" current={sortColumn} dir={sortDir} buildHref={buildHref} align="right">Amount</SortableTh>
              <Th align="right"><span className="sr-only">Reviewed</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={(filter === 'to_review' ? 8 : 7) + (showDetails ? 2 : 0) + (proView ? 1 : 0)} className="px-4 py-6 text-center text-zinc-500">
                  No transactions match.
                </td>
              </tr>
            )}
            {(() => {
              // Pre-count rows per contact (within this page) so the group
              // header can show the local count alongside the contact name.
              // Only populated for the to_review filter — other views don't
              // group, the loop below ignores the map.
              const perContactCount = new Map<string, number>();
              if (filter === 'to_review' || filter === 'to_verify') {
                for (const r of rows) {
                  const key = rowGroupKey(r);
                  perContactCount.set(key, (perContactCount.get(key) ?? 0) + 1);
                }
              }
              const colSpan = (filter === 'to_review' ? 8 : 7) + (showDetails ? 2 : 0) + (proView ? 1 : 0);
              return rows.map((t, i) => {
                const review = filter === 'to_review' ? whyReview(t.pfcDetailed, t.categoryAccountName) : null;
                // A txn fresh out of plaid-promote with no PFC primary match
                // sits with categoryAccountId=null AND journalEntryId=null
                // for the 1–4 min auto-categorize window. Show "Categorizing…"
                // rather than "Uncategorized" so the user understands it's
                // in-flight, not abandoned. After 15 min the
                // stuck-pending-fallback job parks it on Uncategorized
                // Expense/Income with a JE, so this state is naturally
                // bounded.
                const isCategorizing =
                  !t.categoryAccountId &&
                  !t.journalEntryId &&
                  !!t.createdAt &&
                  new Date(t.createdAt).getTime() > stuckCutoffMs;
                // "Uncategorized" = no category, or the seeded Uncategorized
                // fallback account. Gates the reviewed toggle.
                const txnUncategorized =
                  !t.categoryAccountId ||
                  t.categoryAccountName === 'Uncategorized Expense' ||
                  t.categoryAccountName === 'Uncategorized Income';
                const prev = i > 0 ? rows[i - 1] : null;
                const groupKey = rowGroupKey(t);
                const isFirstOfGroup =
                  (filter === 'to_review' || filter === 'to_verify') &&
                  (!prev || rowGroupKey(prev) !== groupKey);
                // Tag every row with its contact-group key so the GuidedTriage
                // overlay can spotlight the active group via DOM querying.
                const guideAttr = guideMode ? { 'data-guide-group': groupKey } : {};
                return (
                  <Fragment key={t.id}>
                    {isFirstOfGroup && (
                      <tr {...guideAttr} className="border-t border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
                        <td
                          colSpan={colSpan}
                          className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
                        >
                          {t.contactName ?? '(No contact)'}
                          {guideVerify && t.categoryAccountName ? ` — ${t.categoryAccountName}` : ''}
                          <span className="ml-2 font-normal text-zinc-500">
                            {perContactCount.get(groupKey)} on this page
                          </span>
                        </td>
                      </tr>
                    )}
                    <tr {...guideAttr} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                      <td className="px-4 py-2">
                        <input type="checkbox" name="ids" value={t.id} form="bulk-form" className="h-4 w-4" />
                      </td>
                      <Td><Link href={`/transactions/${t.id}`} prefetch={false} className="hover:underline">{t.date ?? '—'}</Link></Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {t.hasReceiptMatch && (
                            <span className="inline-flex items-center rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                              Linked Receipt
                            </span>
                          )}
                          <span>{t.bankDescription ?? t.description ?? '—'}</span>
                        </div>
                      </Td>
                      <Td>{t.contactName ?? '—'}</Td>
                      {showDetails && <Td>{t.bankAccountName ?? '—'}</Td>}
                      <Td>
                        {t.splitCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                              Split
                            </span>
                            <span className="text-zinc-700 dark:text-zinc-300">
                              {t.splitCount} categories
                            </span>
                          </span>
                        ) : (
                          t.categoryAccountName ??
                          (isCategorizing ? (
                            <span className="text-zinc-500 italic">Categorizing…</span>
                          ) : (
                            <span className="text-amber-600">Uncategorized</span>
                          ))
                        )}
                      </Td>
                      {proView && (
                        <Td>
                          <EvidenceDrawer
                            transactionId={t.id}
                            confidence={t.aiConfidence}
                          />
                        </Td>
                      )}
                      {filter === 'to_review' && (
                        <Td>
                          {review ? (
                            <span
                              className={`inline-flex flex-col gap-0.5 ${review.tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : review.tone === 'blue' ? 'text-blue-700 dark:text-blue-400' : 'text-zinc-600 dark:text-zinc-400'}`}
                              title={review.question?.description ?? undefined}
                            >
                              <span className="text-xs font-medium">{review.label}</span>
                              {review.question && (
                                <span className="text-[11px] italic text-zinc-700 dark:text-zinc-300">{review.question.question}</span>
                              )}
                              {t.pfcDetailed && (
                                <span className="font-mono text-[10px] text-zinc-500">{t.pfcDetailed}</span>
                              )}
                              {(() => {
                                const ageDays = t.createdAt
                                  ? Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86_400_000)
                                  : 0;
                                if (ageDays < 1) return null;
                                // Flag items aging in the queue so the reviewer (and the
                                // "Request client input" nudge) can prioritize stale ones.
                                const stale = ageDays >= 7;
                                return (
                                  <span className={`text-[10px] ${stale ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-zinc-400'}`}>
                                    waiting {ageDays}d{stale ? ' ⚠' : ''}
                                  </span>
                                );
                              })()}
                            </span>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </Td>
                      )}
                      {showDetails && <Td>{t.journalEntryId ? '✓' : <span className="text-amber-600">—</span>}</Td>}
                      <Td align="right" mono>
                        {t.amount != null ? (
                          <span className={t.type === 'deposit' ? 'font-medium text-emerald-600 dark:text-emerald-400' : undefined}>
                            {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(t.amount)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td align="right">
                        {filter === 'removed_duplicates' ? (
                          <RestoreDuplicateButton transactionId={t.id} />
                        ) : (
                          <ReviewedToggle
                            transactionId={t.id}
                            reviewed={!!t.verified}
                            uncategorized={txnUncategorized}
                          />
                        )}
                      </Td>
                    </tr>
                  </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} buildHref={buildHref} />
    </div>
  );
}

function TransactionsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading recent transactions…</p>
        </div>
      </header>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="h-5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
          ))}
        </div>
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400 ${align === 'right' ? 'text-right' : ''}`}>{children}</th>;
}

/**
 * Clickable column header. Click cycles direction:
 *   - Not the current sort column → sort by it descending
 *   - Already current, descending → flip to ascending
 *   - Already current, ascending → flip to descending
 * Sorts always reset page=1 since the row positions change.
 */
function SortableTh({
  col,
  current,
  dir,
  buildHref,
  align = 'left',
  children,
}: {
  col: SortColumn;
  current: SortColumn;
  dir: SortDir;
  buildHref: (overrides: Record<string, string | undefined>) => string;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const isCurrent = current === col;
  const nextDir: SortDir = isCurrent ? (dir === 'asc' ? 'desc' : 'asc') : 'desc';
  const arrow = isCurrent ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
  const href = buildHref({ sort: col, dir: nextDir, page: undefined });
  return (
    <th
      className={`px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400 ${align === 'right' ? 'text-right' : ''}`}
    >
      <Link
        href={href}
        prefetch={false}
        className={`inline-flex items-center hover:text-zinc-900 dark:hover:text-zinc-100 ${
          isCurrent ? 'text-zinc-900 dark:text-zinc-100' : ''
        }`}
      >
        {children}
        <span className="ml-0.5 inline-block w-3 text-xs">{arrow}</span>
      </Link>
    </th>
  );
}

interface ReviewContext {
  label: string;
  tone: 'amber' | 'blue' | 'zinc';
  question: PfcQuestionTemplate | null;
}

/**
 * Build a short, user-friendly explanation of why a transaction is sitting in
 * the review queue, plus a templated clarifying question for the client when
 * the row has a PFC mapping. The PFC classification (transfer / uncategorized
 * / etc.) is the primary signal; falls back to "Uncategorized" if the row has
 * no PFC and no category account.
 */
function whyReview(
  pfcDetailed: string | null,
  categoryAccountName: string | null,
): ReviewContext | null {
  const mapping = pfcDetailed ? getPfcMapping(pfcDetailed) : null;
  const cls: PfcClassification | null = mapping?.classification ?? null;
  const question = mapping ? pfcQuestion(mapping) : null;

  // Direct PFC-driven cases.
  if (cls === 'asset_movement') return { label: 'Internal transfer', tone: 'blue', question };
  if (cls === 'transfer_review') return { label: 'Ambiguous transfer', tone: 'blue', question };
  if (cls === 'uncategorized') return { label: 'Uncategorized', tone: 'amber', question };

  // Confident classification but landed on the uncategorized fallback —
  // we can detect it by the category name being our seeded label.
  if (categoryAccountName === 'Uncategorized Expense' || categoryAccountName === 'Uncategorized Income') {
    return { label: 'No matching CoA slot', tone: 'amber', question };
  }

  // No category at all → just labeled Uncategorized.
  if (!categoryAccountName) return { label: 'Uncategorized', tone: 'amber', question };

  // PFC was high-confidence and landed somewhere real, but reviewed=false.
  // Likely no PFC at all (legacy data) or contact resolution flagged it.
  if (!pfcDetailed) return { label: 'No PFC signal', tone: 'zinc', question: null };
  return { label: 'Needs review', tone: 'zinc', question };
}

function Td({ children, align = 'left', mono = false }: { children: React.ReactNode; align?: 'left' | 'right'; mono?: boolean }) {
  return <td className={`px-4 py-2 text-zinc-700 dark:text-zinc-300 ${align === 'right' ? 'text-right' : ''} ${mono ? 'tabular-nums' : ''}`}>{children}</td>;
}

function Pagination({
  page,
  pageCount,
  buildHref,
}: {
  page: number;
  pageCount: number;
  buildHref: (overrides: Record<string, string | undefined>) => string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="flex items-center gap-2 text-sm">
      {page > 1 && (
        <a
          href={buildHref({ page: String(page - 1) })}
          className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ← Previous
        </a>
      )}
      {page < pageCount && (
        <a
          href={buildHref({ page: String(page + 1) })}
          className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Next →
        </a>
      )}
    </nav>
  );
}
