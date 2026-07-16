import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc, count, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, importedTransactions, chartOfAccounts, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { PromoteButton } from './_components/PromoteButton';

interface PageProps {
  params: Promise<{ id: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function ImportDetailPage({ params }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { id } = await params;

  const [importRow] = await db
    .select({
      id: imports.id,
      method: imports.method,
      importMethod: imports.importMethod,
      filename: imports.filename,
      transactionCount: imports.transactionCount,
      startDate: imports.startDate,
      endDate: imports.endDate,
      status: imports.status,
      errorMessage: imports.errorMessage,
      createdAt: imports.createdAt,
      savedFilePath: imports.savedFilePath,
      accountId: imports.accountId,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      veryfiDocumentId: imports.veryfiDocumentId,
      veryfiRawJson: imports.veryfiRawJson,
    })
    .from(imports)
    .leftJoin(chartOfAccounts, eq(imports.accountId, chartOfAccounts.id))
    .where(and(eq(imports.id, id), eq(imports.organizationId, orgId)))
    .limit(1);

  if (!importRow) notFound();

  // Parse Veryfi metadata for the bank-info card
  interface VeryfiBankMeta {
    bank_name?: string;
    bank_address?: string;
    bank_website?: string;
    swift?: string;
    routing_number?: string;
    account_holder_name?: string;
    account_holder_address?: string;
    account_number?: string;
    account_type?: string;
    iban_number?: string;
    statement_date?: string;
    period_start_date?: string;
    period_end_date?: string;
    beginning_balance?: number;
    ending_balance?: number;
    minimum_due?: number;
    due_date?: string;
    accounts?: Array<{
      account_number?: string;
      account_type?: string;
      starting_balance?: number;
      ending_balance?: number;
    }>;
  }
  let veryfi: VeryfiBankMeta | null = null;
  if (importRow.veryfiRawJson) {
    try {
      veryfi = JSON.parse(importRow.veryfiRawJson) as VeryfiBankMeta;
    } catch {
      // ignore — show without enrichment
    }
  }

  // CSV imports skip the imported_transactions table and write straight to
  // transactions. Detect by `method === 'csv'` and source rows from the
  // right table so the detail page actually shows the import contents.
  const isCsv = importRow.method === 'csv';

  let rows: Array<{
    id: string;
    date: string | null;
    description: string | null;
    amount: number | string | null;
    type: string | null;
    referenceNumber: string | null;
    merchantName: string | null;
    status: string | null;
    promotionStatus: string | null;
    promotedTransactionId: string | null;
  }>;
  let totalCount = 0;
  let pendingCount = 0;

  if (isCsv) {
    const txnRows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        description: transactions.description,
        amount: transactions.amount,
        type: transactions.type,
        reference: transactions.reference,
        journalEntryId: transactions.journalEntryId,
      })
      .from(transactions)
      .where(and(eq(transactions.importId, id), eq(transactions.organizationId, orgId)))
      .orderBy(asc(transactions.date));

    rows = txnRows.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type,
      referenceNumber: t.reference,
      merchantName: null,
      status: t.journalEntryId ? 'posted' : 'pending',
      promotionStatus: t.journalEntryId ? 'posted' : 'pending',
      promotedTransactionId: t.id, // CSV rows are the transaction itself
    }));
    totalCount = rows.length;
    pendingCount = 0; // CSV rows are already promoted (they ARE transactions)
  } else {
    const [[total], [pendingAgg], importedRows] = await Promise.all([
      db.select({ n: count() }).from(importedTransactions).where(eq(importedTransactions.importId, id)),
      db
        .select({ n: count() })
        .from(importedTransactions)
        .where(
          and(
            eq(importedTransactions.importId, id),
            isNull(importedTransactions.promotedTransactionId),
          ),
        ),
      db
        .select({
          id: importedTransactions.id,
          date: importedTransactions.date,
          description: importedTransactions.description,
          amount: importedTransactions.amount,
          type: importedTransactions.type,
          referenceNumber: importedTransactions.referenceNumber,
          merchantName: importedTransactions.merchantName,
          status: importedTransactions.status,
          promotionStatus: importedTransactions.promotionStatus,
          promotedTransactionId: importedTransactions.promotedTransactionId,
        })
        .from(importedTransactions)
        .where(eq(importedTransactions.importId, id))
        .orderBy(asc(importedTransactions.date)),
    ]);
    rows = importedRows;
    totalCount = total?.n ?? 0;
    pendingCount = pendingAgg?.n ?? 0;
  }

  const sumAbs = rows.reduce((s, r) => s + Math.abs(Number(r.amount ?? 0)), 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/imports" className="text-sm text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Imports
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{importRow.filename ?? 'Import'}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {totalCount.toLocaleString()} transaction{totalCount === 1 ? '' : 's'} · total {fmt(sumAbs)}
          </p>
        </div>
        <span
          className={`rounded px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${
            importRow.status === 'completed' || importRow.status === 'success'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : importRow.status === 'failed' || importRow.status === 'error'
                ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
          }`}
        >
          {importRow.status}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950 md:grid-cols-4">
        <Field label="Method" value={`${importRow.method}${importRow.importMethod ? ` · ${importRow.importMethod}` : ''}`} />
        <Field
          label="Account"
          value={importRow.accountNumber && importRow.accountName ? `${importRow.accountNumber} · ${importRow.accountName}` : '—'}
        />
        <Field label="Period" value={importRow.startDate && importRow.endDate ? `${importRow.startDate} → ${importRow.endDate}` : '—'} />
        <Field label="Uploaded" value={importRow.createdAt ? new Date(importRow.createdAt).toLocaleString() : '—'} />
      </div>

      {veryfi && (
        <BankMetadataCard meta={veryfi} />
      )}

      {importRow.errorMessage && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <strong>Error:</strong> {importRow.errorMessage}
        </div>
      )}

      {totalCount > 0 && (importRow.status === 'completed' || importRow.status === 'success') && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-sm">
            <div className="font-medium">Promote into transactions</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {pendingCount === 0
                ? 'All extracted transactions have been promoted.'
                : `${pendingCount} ready to promote · idempotent (already-promoted rows are skipped).`}
            </div>
          </div>
          <PromoteButton importId={importRow.id} pendingCount={pendingCount} />
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Type</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Reference</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                  {importRow.status === 'processing'
                    ? 'Still processing on Veryfi… refresh in a minute.'
                    : 'No transactions extracted from this import.'}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const amount = Number(r.amount ?? 0);
              const isCredit = amount > 0 || r.type === 'credit';
              return (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                    {r.date ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {r.description || r.merchantName || <em className="text-zinc-400">—</em>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">{r.type ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">{r.referenceNumber ?? '—'}</td>
                  <td className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
                    isCredit ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-700 dark:text-zinc-300'
                  }`}>
                    {fmt(amount)}
                  </td>
                  <td className="px-4 py-2">
                    {r.promotedTransactionId ? (
                      <Link
                        href={`/transactions/${r.promotedTransactionId}`}
                        className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
                      >
                        promoted →
                      </Link>
                    ) : (
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {r.promotionStatus ?? r.status ?? 'pending'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-medium text-zinc-700 dark:text-zinc-300">{value}</div>
    </div>
  );
}

function fmtMoney(n: number | undefined | null): string {
  if (typeof n !== 'number') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

interface BankMeta {
  bank_name?: string;
  bank_address?: string;
  bank_website?: string;
  swift?: string;
  routing_number?: string;
  account_holder_name?: string;
  account_holder_address?: string;
  account_number?: string;
  account_type?: string;
  iban_number?: string;
  beginning_balance?: number;
  ending_balance?: number;
  accounts?: Array<{
    account_number?: string;
    account_type?: string;
    starting_balance?: number;
    ending_balance?: number;
  }>;
}

function BankMetadataCard({ meta }: { meta: BankMeta }) {
  const acct = meta.accounts?.[0];
  const beginning = meta.beginning_balance ?? acct?.starting_balance;
  const ending = meta.ending_balance ?? acct?.ending_balance;
  const accountNumber = meta.account_number ?? acct?.account_number;
  const accountType = meta.account_type ?? acct?.account_type;

  const hasAnything =
    meta.bank_name || meta.account_holder_name || accountNumber || meta.routing_number ||
    typeof beginning === 'number' || typeof ending === 'number';

  if (!hasAnything) return null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Bank statement details</div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Institution</div>
          {meta.bank_name && <div className="font-medium">{meta.bank_name}</div>}
          {meta.bank_address && <div className="text-xs text-zinc-600 dark:text-zinc-400">{meta.bank_address}</div>}
          {meta.bank_website && (
            <a href={meta.bank_website} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline dark:text-blue-400">
              {meta.bank_website}
            </a>
          )}
          {meta.routing_number && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">Routing: <span className="font-mono">{meta.routing_number}</span></div>
          )}
          {meta.swift && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">SWIFT: <span className="font-mono">{meta.swift}</span></div>
          )}
        </div>
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Account holder</div>
          {meta.account_holder_name && <div className="font-medium">{meta.account_holder_name}</div>}
          {meta.account_holder_address && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{meta.account_holder_address}</div>
          )}
          {accountNumber && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">
              Account: <span className="font-mono">{accountNumber}</span>
              {accountType && <span className="ml-2 text-zinc-500">({accountType})</span>}
            </div>
          )}
          {meta.iban_number && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">IBAN: <span className="font-mono">{meta.iban_number}</span></div>
          )}
        </div>
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Balances</div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Beginning</span>
            <span className="tabular-nums">{fmtMoney(beginning)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Ending</span>
            <span className="tabular-nums">{fmtMoney(ending)}</span>
          </div>
          {typeof beginning === 'number' && typeof ending === 'number' && (
            <div className="mt-1 flex justify-between border-t border-zinc-100 pt-2 text-sm font-medium dark:border-zinc-800">
              <span>Net change</span>
              <span className={`tabular-nums ${ending - beginning >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
                {fmtMoney(ending - beginning)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
