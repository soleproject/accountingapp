import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  plaidAccounts,
  plaidRawTransactions,
  plaidSyncBatches,
  transactions,
  chartOfAccounts,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

interface PageProps { params: Promise<{ id: string }>; }

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function PlaidAccountDetailPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  const [account] = await db
    .select({
      id: plaidAccounts.id,
      institutionName: plaidAccounts.institutionName,
      accountName: plaidAccounts.accountName,
      last4: plaidAccounts.last4,
      accountType: plaidAccounts.accountType,
      subtype: plaidAccounts.subtype,
      syncStatus: plaidAccounts.syncStatus,
      lastSyncedAt: plaidAccounts.lastSyncedAt,
      lastSyncErrorAt: plaidAccounts.lastSyncErrorAt,
      lastSyncError: plaidAccounts.lastSyncError,
      plaidCursor: plaidAccounts.plaidCursor,
      chartOfAccountId: plaidAccounts.chartOfAccountId,
      mappedAccountNumber: chartOfAccounts.accountNumber,
      mappedAccountName: chartOfAccounts.accountName,
    })
    .from(plaidAccounts)
    .leftJoin(chartOfAccounts, eq(plaidAccounts.chartOfAccountId, chartOfAccounts.id))
    .where(and(eq(plaidAccounts.id, id), eq(plaidAccounts.linkedOrganizationId, orgId)))
    .limit(1);
  if (!account) notFound();

  const [syncs, raw] = await Promise.all([
    db
      .select({
        id: plaidSyncBatches.id,
        addedCount: plaidSyncBatches.addedCount,
        modifiedCount: plaidSyncBatches.modifiedCount,
        removedCount: plaidSyncBatches.removedCount,
        cursor: plaidSyncBatches.cursor,
        createdAt: plaidSyncBatches.createdAt,
      })
      .from(plaidSyncBatches)
      .where(eq(plaidSyncBatches.plaidAccountId, account.id))
      .orderBy(desc(plaidSyncBatches.createdAt))
      .limit(50),
    db
      .select({
        id: plaidRawTransactions.id,
        plaidTransactionId: plaidRawTransactions.plaidTransactionId,
        date: plaidRawTransactions.date,
        amount: plaidRawTransactions.amount,
        description: plaidRawTransactions.description,
      })
      .from(plaidRawTransactions)
      .where(eq(plaidRawTransactions.plaidAccountId, account.id))
      .orderBy(desc(plaidRawTransactions.date))
      .limit(200),
  ]);

  const refs = raw.map((r) => `plaid:${r.plaidTransactionId}`);
  const promoted = refs.length > 0
    ? await db
        .select({ reference: transactions.reference, txnId: transactions.id, journalEntryId: transactions.journalEntryId })
        .from(transactions)
        .where(and(eq(transactions.organizationId, orgId), inArray(transactions.reference, refs)))
    : [];
  const promotedMap = new Map(promoted.map((p) => [p.reference, p]));

  const totalRaw = raw.length;
  const totalPromoted = promotedMap.size;
  const pending = totalRaw - totalPromoted;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/integrations/plaid" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to Plaid integrations
      </Link>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {account.institutionName} · {account.accountName}
            {account.last4 && <span className="ml-2 text-zinc-400">···{account.last4}</span>}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {account.accountType}{account.subtype && ` / ${account.subtype}`} · sync: {account.syncStatus}
            {account.lastSyncedAt && ` · last ${new Date(account.lastSyncedAt).toLocaleString()}`}
          </p>
          {account.mappedAccountNumber && (
            <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
              Mapped to COA: {account.mappedAccountNumber} · {account.mappedAccountName}
            </p>
          )}
          {!account.chartOfAccountId && (
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              ⚠ Not yet mapped to a COA bank account — promotion is blocked until mapped.
            </p>
          )}
        </div>
      </header>

      {account.lastSyncError && (
        <section className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-900/20">
          <strong className="text-red-900 dark:text-red-100">Last sync error</strong>
          <p className="mt-1 text-red-800 dark:text-red-200">{account.lastSyncError}</p>
          {account.lastSyncErrorAt && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-300">
              {new Date(account.lastSyncErrorAt).toLocaleString()}
            </p>
          )}
        </section>
      )}

      <section className="grid grid-cols-3 gap-3">
        <Stat label="Raw fetched" value={totalRaw.toLocaleString()} />
        <Stat label="Promoted" value={totalPromoted.toLocaleString()} tone="emerald" />
        <Stat label="Pending" value={pending.toLocaleString()} tone={pending > 0 ? 'amber' : 'zinc'} />
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Sync history (last {syncs.length})
          </h2>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">When</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Added</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Modified</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Removed</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Cursor (after)</th>
            </tr>
          </thead>
          <tbody>
            {syncs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">No sync runs yet.</td>
              </tr>
            )}
            {syncs.map((s) => (
              <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                  {new Date(s.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{s.addedCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{s.modifiedCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{s.removedCount}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-500">{s.cursor ? s.cursor.slice(0, 24) + '…' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            Recent raw transactions (last {raw.length})
          </h2>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Plaid Amount</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">JE</th>
            </tr>
          </thead>
          <tbody>
            {raw.map((r) => {
              const ref = `plaid:${r.plaidTransactionId}`;
              const p = promotedMap.get(ref);
              return (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.date}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.description ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {fmt(Number(r.amount))}
                  </td>
                  <td className="px-4 py-2">
                    {p ? (
                      <Link href={`/transactions/${p.txnId}`} className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 hover:underline dark:bg-emerald-900/30 dark:text-emerald-300">
                        ✓ Promoted
                      </Link>
                    ) : (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {p?.journalEntryId ? (
                      <Link href={`/journal-entries/${p.journalEntryId}`} className="text-xs underline text-zinc-700 dark:text-zinc-300">
                        View JE
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="text-xs text-zinc-500 dark:text-zinc-400">
        <details>
          <summary className="cursor-pointer">Cursor (debug)</summary>
          <pre className="mt-2 overflow-auto rounded bg-zinc-50 p-2 font-mono dark:bg-zinc-900">
            {account.plaidCursor ?? '(no cursor — never synced)'}
          </pre>
        </details>
      </section>
    </div>
  );
}

function Stat({ label, value, tone = 'zinc' }: { label: string; value: string; tone?: 'emerald' | 'amber' | 'zinc' }) {
  const palette =
    tone === 'emerald'
      ? 'border-emerald-200 dark:border-emerald-900'
      : tone === 'amber'
        ? 'border-amber-300 dark:border-amber-800'
        : 'border-zinc-200 dark:border-zinc-800';
  return (
    <div className={`rounded-lg border bg-white p-4 dark:bg-zinc-950 ${palette}`}>
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

void sql;
