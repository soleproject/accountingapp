import Link from 'next/link';
import { eq, desc, and, gte, lte, asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, journalEntries, chartOfAccounts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  searchParams: Promise<{
    page?: string;
    accountId?: string;
    from?: string;
    to?: string;
  }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function GeneralLedgerPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const accountId = sp.accountId?.trim() || null;
  const fromDate = sp.from && ISO.test(sp.from) ? sp.from : null;
  const toDate = sp.to && ISO.test(sp.to) ? sp.to : null;

  const conditions = [eq(generalLedger.organizationId, orgId)];
  if (accountId) conditions.push(eq(generalLedger.accountId, accountId));
  if (fromDate) conditions.push(gte(generalLedger.date, `${fromDate}T00:00:00`));
  if (toDate) conditions.push(lte(generalLedger.date, `${toDate}T23:59:59`));
  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [rows, accountList] = await Promise.all([
    db
      .select({
        id: generalLedger.id,
        date: generalLedger.date,
        memo: generalLedger.memo,
        debit: generalLedger.debit,
        credit: generalLedger.credit,
        journalEntryId: generalLedger.journalEntryId,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        contactName: contacts.contactName,
        jeMemo: journalEntries.memo,
        jeReversalOfId: journalEntries.reversalOfId,
        totalCount: sql<number>`count(*) over ()`.mapWith(Number),
        totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}) OVER (), 0)`.as('total_debit'),
        totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}) OVER (), 0)`.as('total_credit'),
      })
      .from(generalLedger)
      .leftJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(generalLedger.contactId, contacts.id))
      .leftJoin(journalEntries, eq(generalLedger.journalEntryId, journalEntries.id))
      .where(where)
      .orderBy(desc(generalLedger.date), desc(generalLedger.createdAt), desc(generalLedger.id))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
      })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.organizationId, orgId))
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const totalCount = rows[0]?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const totalDebit = Number(rows[0]?.totalDebit ?? 0);
  const totalCredit = Number(rows[0]?.totalCredit ?? 0);
  const net = totalDebit - totalCredit;

  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (fromDate) params.set('from', fromDate);
  if (toDate) params.set('to', toDate);
  const buildPageHref = (p: number) => {
    const q = new URLSearchParams(params);
    q.set('page', String(p));
    return `?${q.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">General Ledger</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {totalCount.toLocaleString()} records · Page {page} of {pageCount}
          </p>
        </div>
        <form className="flex flex-wrap items-center gap-2 text-sm">
          <select
            name="accountId"
            defaultValue={accountId ?? ''}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">All accounts</option>
            {accountList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName}
              </option>
            ))}
          </select>
          <input
            type="date"
            name="from"
            defaultValue={fromDate ?? ''}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">to</span>
          <input
            type="date"
            name="to"
            defaultValue={toDate ?? ''}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Apply
          </button>
        </form>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total debits" value={fmt(totalDebit)} />
        <Stat label="Total credits" value={fmt(totalCredit)} />
        <Stat
          label="Net (debits − credits)"
          value={fmt(net)}
          tone={Math.abs(net) < 0.005 ? 'zero' : net > 0 ? 'pos' : 'neg'}
        />
      </section>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Date</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Account</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Contact</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Memo</th>
              <th className="px-4 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">Debit</th>
              <th className="px-4 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">Credit</th>
              <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">JE</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-zinc-500">
                  No general ledger records match.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isReversal = !!r.jeReversalOfId;
              return (
                <tr
                  key={r.id}
                  className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                    {r.date ? r.date.slice(0, 10) : '—'}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {r.accountNumber ? <span className="text-zinc-500">{r.accountNumber}</span> : null}{' '}
                    {r.accountName ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.contactName ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {isReversal && (
                      <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        Reversal
                      </span>
                    )}
                    {r.memo ?? r.jeMemo ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {Number(r.debit ?? 0) > 0 ? fmt(Number(r.debit)) : ''}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {Number(r.credit ?? 0) > 0 ? fmt(Number(r.credit)) : ''}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {r.journalEntryId ? (
                      <Link
                        href={`/journal-entries/${r.journalEntryId}`}
                        prefetch={false}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        view
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <nav className="flex items-center gap-2 text-sm">
          {page > 1 && (
            <a
              href={buildPageHref(page - 1)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              ← Previous
            </a>
          )}
          {page < pageCount && (
            <a
              href={buildPageHref(page + 1)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Next →
            </a>
          )}
        </nav>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' | 'zero' }) {
  const palette =
    tone === 'pos'
      ? 'border-emerald-200 dark:border-emerald-900'
      : tone === 'neg'
        ? 'border-red-200 dark:border-red-900'
        : tone === 'zero'
          ? 'border-zinc-200 dark:border-zinc-800'
          : 'border-zinc-200 dark:border-zinc-800';
  return (
    <div className={`rounded-lg border bg-white p-3 dark:bg-zinc-950 ${palette}`}>
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
