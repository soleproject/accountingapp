import Link from 'next/link';
import { eq, count, desc, asc, inArray, and, ilike, or, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidRawTransactions, plaidAccounts, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 100;

// Subset of Plaid's /transactions/sync row that we surface in the raw feed UI.
// Stored as-is in plaid_raw_transactions.raw_json by server/jobs/plaid-sync.ts.
type PlaidRawJson = {
  merchant_name?: string | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
    confidence_level?: string | null;
  } | null;
};

const VALID_STATUSES = ['all', 'promoted', 'pending'] as const;
type Status = (typeof VALID_STATUSES)[number];

const VALID_SORTS = ['date', 'account', 'description', 'merchant', 'amount'] as const;
type SortColumn = (typeof VALID_SORTS)[number];
type SortDir = 'asc' | 'desc';

interface PageProps {
  searchParams: Promise<{
    page?: string;
    q?: string;
    accountId?: string;
    status?: string;
    start?: string;
    end?: string;
    sort?: string;
    dir?: string;
  }>;
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export default async function PlaidFeedPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  const orgAccounts = await db
    .select({ id: plaidAccounts.id, name: plaidAccounts.accountName, last4: plaidAccounts.last4 })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.linkedOrganizationId, orgId));

  const accountIds = orgAccounts.map((a) => a.id);

  if (accountIds.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-2xl font-semibold">Plaid Raw Feed</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No bank accounts linked yet.</p>
        </header>
      </div>
    );
  }

  const q = sp.q?.trim() || '';
  // Only honour an accountId filter that belongs to this org — the dropdown is
  // populated from orgAccounts, but the param is user-controlled.
  const accountIdFilter = sp.accountId && accountIds.includes(sp.accountId) ? sp.accountId : '';
  const status: Status = (VALID_STATUSES as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as Status)
    : 'all';
  const startDate = sp.start && isValidIsoDate(sp.start) ? sp.start : '';
  const endDate = sp.end && isValidIsoDate(sp.end) ? sp.end : '';
  const sortColumn: SortColumn = (VALID_SORTS as readonly string[]).includes(sp.sort ?? '')
    ? (sp.sort as SortColumn)
    : 'date';
  const sortDir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';

  const merchantExpr = sql<string | null>`(${plaidRawTransactions.rawJson}->>'merchant_name')`;
  const promotedExistsExpr = sql`EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.organization_id = ${orgId}
      AND t.reference = 'plaid:' || ${plaidRawTransactions.plaidTransactionId}
  )`;

  const conditions = [inArray(plaidRawTransactions.plaidAccountId, accountIds)];
  if (accountIdFilter) {
    conditions.push(eq(plaidRawTransactions.plaidAccountId, accountIdFilter));
  }
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      or(
        ilike(plaidRawTransactions.description, pattern),
        sql`(${plaidRawTransactions.rawJson}->>'merchant_name') ILIKE ${pattern}`,
      )!,
    );
  }
  if (startDate) conditions.push(gte(plaidRawTransactions.date, startDate));
  if (endDate) conditions.push(lte(plaidRawTransactions.date, endDate));
  if (status === 'promoted') conditions.push(promotedExistsExpr);
  if (status === 'pending') conditions.push(sql`NOT ${promotedExistsExpr}`);
  const where = and(...conditions);

  const sortColExpr =
    sortColumn === 'account'
      ? sql`${plaidAccounts.accountName}`
      : sortColumn === 'description'
      ? sql`${plaidRawTransactions.description}`
      : sortColumn === 'merchant'
      ? merchantExpr
      : sortColumn === 'amount'
      ? sql`${plaidRawTransactions.amount}`
      : sql`${plaidRawTransactions.date}`;
  const orderBy = [
    sortDir === 'asc'
      ? sql`${sortColExpr} ASC NULLS LAST`
      : sql`${sortColExpr} DESC NULLS LAST`,
    desc(plaidRawTransactions.createdAt),
  ];

  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(plaidRawTransactions).where(where),
    db
      .select({
        id: plaidRawTransactions.id,
        plaidAccountId: plaidRawTransactions.plaidAccountId,
        plaidTransactionId: plaidRawTransactions.plaidTransactionId,
        date: plaidRawTransactions.date,
        amount: plaidRawTransactions.amount,
        description: plaidRawTransactions.description,
        rawJson: plaidRawTransactions.rawJson,
        createdAt: plaidRawTransactions.createdAt,
      })
      .from(plaidRawTransactions)
      .leftJoin(plaidAccounts, eq(plaidRawTransactions.plaidAccountId, plaidAccounts.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const acctMap = new Map(orgAccounts.map((a) => [a.id, a.name]));

  const refs = rows.map((r) => `plaid:${r.plaidTransactionId}`);
  const promoted = refs.length > 0
    ? await db
        .select({ reference: transactions.reference, txnId: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.organizationId, orgId), inArray(transactions.reference, refs)))
    : [];
  const promotedMap = new Map(promoted.map((p) => [p.reference!, p.txnId]));

  const allParams = {
    q: q || undefined,
    accountId: accountIdFilter || undefined,
    status: status !== 'all' ? status : undefined,
    start: startDate || undefined,
    end: endDate || undefined,
    sort: sortColumn !== 'date' || sortDir !== 'desc' ? sortColumn : undefined,
    dir: sortDir !== 'desc' ? sortDir : undefined,
  } as const;
  const buildHref = (overrides: Partial<Record<keyof typeof allParams | 'page', string | undefined>>): string => {
    const merged = { ...allParams, ...overrides } as Record<string, string | undefined>;
    const parts = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
    return parts.length === 0 ? '?' : `?${parts.join('&')}`;
  };

  const hasAnyFilter = !!q || !!accountIdFilter || status !== 'all' || !!startDate || !!endDate;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Plaid Raw Feed</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {totalCount.toLocaleString()} matching · {orgAccounts.length} linked account(s) · Page {page} of {pageCount}
        </p>
      </header>

      <form
        method="get"
        className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
      >
        {/* Preserve sort across filter submits. */}
        {allParams.sort && <input type="hidden" name="sort" value={allParams.sort} />}
        {allParams.dir && <input type="hidden" name="dir" value={allParams.dir} />}

        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search description or merchant…"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Account">
            <select
              name="accountId"
              defaultValue={accountIdFilter}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">All Accounts</option>
              {orgAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.last4 ? ` · ••${a.last4}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue={status}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="all">All</option>
              <option value="promoted">Promoted</option>
              <option value="pending">Pending</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start Date">
              <input
                type="date"
                name="start"
                defaultValue={startDate}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </Field>
            <Field label="End Date">
              <input
                type="date"
                name="end"
                defaultValue={endDate}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Apply filters
          </button>
          {hasAnyFilter && (
            <a
              href={buildHref({
                q: undefined,
                accountId: undefined,
                status: undefined,
                start: undefined,
                end: undefined,
                page: undefined,
              })}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Clear
            </a>
          )}
        </div>
      </form>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <SortableTh col="date" current={sortColumn} dir={sortDir} buildHref={buildHref}>Date</SortableTh>
              <SortableTh col="account" current={sortColumn} dir={sortDir} buildHref={buildHref}>Account</SortableTh>
              <SortableTh col="description" current={sortColumn} dir={sortDir} buildHref={buildHref}>Description</SortableTh>
              <SortableTh col="merchant" current={sortColumn} dir={sortDir} buildHref={buildHref}>Merchant</SortableTh>
              <Th>PFC</Th>
              <SortableTh col="amount" current={sortColumn} dir={sortDir} buildHref={buildHref} align="right">Amount</SortableTh>
              <Th>Status</Th>
              <Th>Plaid ID</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">No raw transactions match.</td>
              </tr>
            )}
            {rows.map((r) => {
              const txnId = promotedMap.get(`plaid:${r.plaidTransactionId}`);
              const raw = (r.rawJson ?? {}) as PlaidRawJson;
              const merchant = raw.merchant_name ?? null;
              const pfcPrimary = raw.personal_finance_category?.primary ?? null;
              const pfcDetailed = raw.personal_finance_category?.detailed ?? null;
              return (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.date}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{acctMap.get(r.plaidAccountId) ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.description ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{merchant ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-zinc-700 dark:text-zinc-300">
                    {pfcPrimary ? (
                      <div className="flex flex-col leading-tight">
                        <span className="font-mono">{pfcPrimary}</span>
                        {pfcDetailed && pfcDetailed !== pfcPrimary && (
                          <span className="font-mono text-[10px] text-zinc-500">{pfcDetailed}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(r.amount))}
                  </td>
                  <td className="px-4 py-2">
                    {txnId ? (
                      <Link href={`/transactions/${txnId}`} className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 hover:underline dark:bg-emerald-900/30 dark:text-emerald-300">
                        ✓ Promoted
                      </Link>
                    ) : (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500">{r.plaidTransactionId.slice(0, 12)}…</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} buildHref={buildHref} />
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

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
      className={`px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 ${align === 'right' ? 'text-right' : ''}`}
    >
      <Link
        href={href}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
    </label>
  );
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
