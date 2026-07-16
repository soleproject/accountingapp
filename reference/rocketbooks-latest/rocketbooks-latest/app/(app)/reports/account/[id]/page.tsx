import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  bills,
  chartOfAccounts,
  contacts,
  invoices,
  journalEntries,
  journalEntryLines,
  transactions,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import { BulkBar } from '../../../transactions/_components/BulkBar';
import { SourceDocBulkBar } from './_components/SourceDocBulkBar';
import { SelectAllCheckbox } from './_components/SelectAllCheckbox';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; back?: string; backLabel?: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const bankAccount = alias(chartOfAccounts, 'bank_account');

export default async function AccountDrillDownPage({ params, searchParams }: PageProps) {
  const { id: accountId } = await params;
  const { from, to, back, backLabel } = await searchParams;
  const orgId = await getCurrentOrgId();
  const fromDate = safeIsoDate(from, yearStartIso());
  const toDate = safeIsoDate(to, todayIso());
  const safeBack = back && back.startsWith('/') ? back : null;
  const safeBackLabel = backLabel && backLabel.trim() ? backLabel : null;

  const [account] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      normalBalance: chartOfAccounts.normalBalance,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!account) notFound();

  const allAccounts = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  const [txnRows, sourceDocLines] = await Promise.all([
    db
      .select({
        id: transactions.id,
        date: transactions.date,
        description: transactions.description,
        bankDescription: transactions.bankDescription,
        journalEntryId: transactions.journalEntryId,
        contactName: contacts.contactName,
        bankAccountName: bankAccount.accountName,
        // SUM the JE-line amounts that hit THIS account on each transaction's
        // JE — that's the proper "ledger detail" view (matches QB / Xero).
        // Per-row debit/credit reconciles to the trial-balance number for
        // this account, unlike the raw transactions.amount magnitude.
        jeDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
        jeCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
        // Mirror the /transactions list: render the "Linked Receipt" pill
        // here too when the row has an unreversed receipt match application.
        hasReceiptMatch: sql<boolean>`EXISTS (
          SELECT 1 FROM receipt_match_applications rma
          WHERE rma.transaction_id = ${transactions.id}
            AND rma.reversed_at IS NULL
        )`,
      })
      .from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .leftJoin(bankAccount, eq(transactions.accountId, bankAccount.id))
      .leftJoin(
        journalEntryLines,
        and(
          eq(journalEntryLines.journalEntryId, transactions.journalEntryId),
          eq(journalEntryLines.accountId, accountId),
        ),
      )
      .where(
        and(
          eq(transactions.organizationId, orgId),
          // A txn surfaces on a drill-down when ANY of:
          //   - its accountId is the drilled account (bank drill-downs)
          //   - its categoryAccountId is the drilled account (legacy
          //     single-mode posting before splits)
          //   - its journal entry has a line on the drilled account
          //     (split / receipt-match / any multi-line posting — the
          //     authoritative test, since the JE is what hit the GL)
          // The third clause is what makes a Walmart split-receipt row
          // appear under Supplies, Meals, AND Sales Tax with the proper
          // per-account amounts on each.
          or(
            eq(transactions.accountId, accountId),
            eq(transactions.categoryAccountId, accountId),
            sql`EXISTS (
              SELECT 1 FROM ${journalEntryLines} jel
              WHERE jel.journal_entry_id = ${transactions.journalEntryId}
                AND jel.account_id = ${accountId}
            )`,
          )!,
          gte(transactions.date, fromDate),
          lte(transactions.date, toDate),
        ),
      )
      .groupBy(
        transactions.id,
        transactions.date,
        transactions.description,
        transactions.bankDescription,
        transactions.journalEntryId,
        contacts.contactName,
        bankAccount.accountName,
      )
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(500),
    // JE lines hitting this account, joined to their parent JE. We pull in
    // every source-type-other-than-transaction so we can bucket: invoice +
    // bill rows go to their own sections, and everything else (manual JEs
    // with sourceType=null, payments, etc.) lands in the catch-all "Journal
    // entries" section. Without this, accounts that only had manual JEs hit
    // them — e.g. Uncategorized Expense — showed up empty because no
    // section claimed the rows.
    db
      .select({
        journalEntryId: journalEntries.id,
        journalEntryDate: journalEntries.date,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        jeMemo: journalEntries.memo,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        memo: journalEntryLines.memo,
        contactName: contacts.contactName,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .leftJoin(contacts, eq(journalEntryLines.contactId, contacts.id))
      .where(
        and(
          eq(journalEntries.organizationId, orgId),
          eq(journalEntryLines.accountId, accountId),
          gte(journalEntries.date, fromDate),
          lte(journalEntries.date, toDate),
          // sourceType='transaction' is handled by the Transactions section
          // via transactions.categoryAccountId — exclude here to avoid the
          // same row appearing twice.
          or(
            isNull(journalEntries.sourceType),
            ne(journalEntries.sourceType, 'transaction'),
          )!,
          // Receipt-match (and other future) JEs that get re-pointed to a
          // transaction via transactions.journal_entry_id are ALSO covered
          // by the Transactions section above. Without this clause the JE
          // shows up in both sections and the account's total
          // double-counts. The NOT EXISTS keys on the JE id so any
          // sourceType still gets excluded once it's been linked to a txn.
          sql`NOT EXISTS (
            SELECT 1 FROM ${transactions} t
            WHERE t.journal_entry_id = ${journalEntries.id}
              AND t.organization_id = ${orgId}
          )`,
          // Hide reversal pairs. Mirrors the journal-entries page's
          // default-on filter: skip rows where the JE has been reversed,
          // and skip the reversal entries themselves.
          isNull(journalEntries.reversalOfId),
          sql`NOT EXISTS (
            SELECT 1 FROM journal_entries je_rev
            WHERE je_rev.reversal_of_id = ${journalEntries.id}
          )`,
        ),
      ),
  ]);

  const isDebitNormal = account.normalBalance === 'debit';
  const lineImpact = (debit: unknown, credit: unknown) => {
    const d = Number(debit ?? 0);
    const c = Number(credit ?? 0);
    return isDebitNormal ? d - c : c - d;
  };

  // Sum line impacts per source document so we can show the per-doc total
  // attributable to this account, even when a doc has multiple lines.
  const invoiceImpact = new Map<string, { jeId: string; amount: number; memo: string | null }>();
  const billImpact = new Map<string, { jeId: string; amount: number; memo: string | null }>();
  // Manual JEs (sourceType=null) and any other non-document source land
  // here, keyed by JE id so a single multi-line manual entry shows as one row.
  const manualJeImpact = new Map<
    string,
    { jeId: string; date: string | null; sourceType: string | null; memo: string | null; contactName: string | null; amount: number }
  >();
  for (const l of sourceDocLines) {
    if (l.sourceType === 'invoice' && l.sourceId) {
      const prior = invoiceImpact.get(l.sourceId);
      invoiceImpact.set(l.sourceId, {
        jeId: l.journalEntryId,
        amount: (prior?.amount ?? 0) + lineImpact(l.debit, l.credit),
        memo: prior?.memo ?? l.memo,
      });
    } else if (l.sourceType === 'bill' && l.sourceId) {
      const prior = billImpact.get(l.sourceId);
      billImpact.set(l.sourceId, {
        jeId: l.journalEntryId,
        amount: (prior?.amount ?? 0) + lineImpact(l.debit, l.credit),
        memo: prior?.memo ?? l.memo,
      });
    } else {
      const prior = manualJeImpact.get(l.journalEntryId);
      manualJeImpact.set(l.journalEntryId, {
        jeId: l.journalEntryId,
        date: prior?.date ?? l.journalEntryDate,
        sourceType: prior?.sourceType ?? l.sourceType,
        memo: prior?.memo ?? l.memo ?? l.jeMemo,
        contactName: prior?.contactName ?? l.contactName,
        amount: (prior?.amount ?? 0) + lineImpact(l.debit, l.credit),
      });
    }
  }

  const invoiceIds = Array.from(invoiceImpact.keys());
  const billIds = Array.from(billImpact.keys());

  const [invoiceRows, billRows] = await Promise.all([
    invoiceIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; invoiceNumber: string | null; invoiceDate: string; status: string; contactName: string | null }>)
      : db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            invoiceDate: invoices.invoiceDate,
            status: invoices.status,
            contactName: contacts.contactName,
          })
          .from(invoices)
          .leftJoin(contacts, eq(invoices.contactId, contacts.id))
          .where(and(eq(invoices.organizationId, orgId), inArray(invoices.id, invoiceIds)))
          .orderBy(desc(invoices.invoiceDate)),
    billIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; billNumber: string | null; billDate: string; status: string; contactName: string | null }>)
      : db
          .select({
            id: bills.id,
            billNumber: bills.billNumber,
            billDate: bills.billDate,
            status: bills.status,
            contactName: contacts.contactName,
          })
          .from(bills)
          .leftJoin(contacts, eq(bills.contactId, contacts.id))
          .where(and(eq(bills.organizationId, orgId), inArray(bills.id, billIds)))
          .orderBy(desc(bills.billDate)),
  ]);

  // Walk transactions oldest → newest to compute a running balance per row.
  // The displayed list is newest-first, but the balance at each row reflects
  // the cumulative position AS OF that row's date. Sign by normalBalance so
  // positive = the account moved in its natural direction.
  const txnAscending = [...txnRows].reverse();
  let running = 0;
  const txnRunningById = new Map<string, number>();
  let totalDebit = 0;
  let totalCredit = 0;
  for (const r of txnAscending) {
    const d = Number(r.jeDebit ?? 0);
    const c = Number(r.jeCredit ?? 0);
    running += isDebitNormal ? d - c : c - d;
    txnRunningById.set(r.id, running);
    totalDebit += d;
    totalCredit += c;
  }
  const txnRowsWithBalance = txnRows.map((r) => ({
    ...r,
    debit: Number(r.jeDebit ?? 0),
    credit: Number(r.jeCredit ?? 0),
    runningBalance: txnRunningById.get(r.id) ?? 0,
    hasReceiptMatch: !!r.hasReceiptMatch,
  }));
  const txnEndingBalance = running;
  const invoicesTotal = Array.from(invoiceImpact.values()).reduce((s, v) => s + v.amount, 0);
  const billsTotal = Array.from(billImpact.values()).reduce((s, v) => s + v.amount, 0);
  const manualJeRows = Array.from(manualJeImpact.values()).sort((a, b) =>
    (b.date ?? '').localeCompare(a.date ?? ''),
  );
  const manualJeTotal = manualJeRows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {(() => {
            // Caller-supplied back wins (preserves origin across nested
            // drilldowns); otherwise infer from the account's gaapType:
            // asset / liability / equity → balance sheet, else income statement.
            let backHref: string;
            let backText: string;
            if (safeBack) {
              backHref = safeBack;
              backText = `← ${safeBackLabel ?? 'Back'}`;
            } else {
              const gaap = (account.gaapType ?? '').toLowerCase();
              const isBalanceSheet =
                gaap.includes('asset') || gaap.includes('liability') || gaap === 'equity';
              backHref = isBalanceSheet
                ? `/reports/balance-sheet?asOf=${encodeURIComponent(toDate)}`
                : `/reports/income-statement?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`;
              backText = isBalanceSheet ? '← Balance sheet' : '← Income statement';
            }
            return (
              <Link
                href={backHref}
                className="text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                {backText}
              </Link>
            );
          })()}
          <h1 className="mt-1 text-2xl font-semibold">
            {account.accountNumber} · {account.accountName}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {fromDate} → {toDate} · {account.gaapType}
          </p>
        </div>
        <form className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500">From</label>
            <input
              type="date"
              name="from"
              defaultValue={fromDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500">To</label>
            <input
              type="date"
              name="to"
              defaultValue={toDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <button
            type="submit"
            className="h-8 rounded-md border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Apply
          </button>
        </form>
      </header>

      <TransactionsSection
        rows={txnRowsWithBalance}
        totalDebit={totalDebit}
        totalCredit={totalCredit}
        endingBalance={txnEndingBalance}
        accounts={allAccounts}
        forwardBack={safeBack}
        forwardBackLabel={safeBackLabel}
      />

      {invoiceRows.length > 0 && (
        <InvoicesSection
          accountId={accountId}
          accounts={allAccounts}
          rows={invoiceRows.map((r) => ({
            ...r,
            jeId: invoiceImpact.get(r.id)!.jeId,
            amount: invoiceImpact.get(r.id)!.amount,
          }))}
          total={invoicesTotal}
        />
      )}

      {billRows.length > 0 && (
        <BillsSection
          accountId={accountId}
          accounts={allAccounts}
          rows={billRows.map((r) => ({
            ...r,
            jeId: billImpact.get(r.id)!.jeId,
            amount: billImpact.get(r.id)!.amount,
          }))}
          total={billsTotal}
        />
      )}

      {manualJeRows.length > 0 && (
        <JournalEntriesSection
          accountId={accountId}
          accounts={allAccounts}
          rows={manualJeRows}
          total={manualJeTotal}
        />
      )}
    </div>
  );
}

function JournalEntriesSection({
  accountId,
  accounts,
  rows,
  total,
}: {
  accountId: string;
  accounts: Array<{ id: string; accountNumber: string; accountName: string; accountType: string | null }>;
  rows: Array<{
    jeId: string;
    date: string | null;
    sourceType: string | null;
    memo: string | null;
    contactName: string | null;
    amount: number;
  }>;
  total: number;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Journal entries
        </h2>
        <span className="text-xs text-zinc-500">
          {rows.length} row{rows.length === 1 ? '' : 's'} · manual or non-document
        </span>
      </header>

      <div className="px-4 py-3">
        <SourceDocBulkBar
          formId="je-bulk-form"
          fromAccountId={accountId}
          accounts={accounts}
          noun="journal entries"
        />
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="w-10 px-4 py-2">
              <SelectAllCheckbox formId="je-bulk-form" />
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Source</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">JE</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              On this account
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.jeId} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              <td className="px-4 py-2">
                <input
                  type="checkbox"
                  name="journalEntryIds"
                  value={r.jeId}
                  form="je-bulk-form"
                  className="h-4 w-4"
                />
              </td>
              <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.date ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.memo ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.contactName ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.sourceType ?? 'manual'}</td>
              <td className="px-4 py-2 font-mono text-xs text-zinc-500" title={r.jeId}>
                <Link href={`/journal-entries/${r.jeId}`} className="hover:underline">
                  {r.jeId.slice(0, 8)}
                </Link>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {fmt(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={6} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Total on this account
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function TransactionsSection({
  rows,
  totalDebit,
  totalCredit,
  endingBalance,
  accounts,
  forwardBack,
  forwardBackLabel,
}: {
  rows: Array<{
    id: string;
    date: string | null;
    description: string | null;
    bankDescription: string | null;
    journalEntryId: string | null;
    contactName: string | null;
    bankAccountName: string | null;
    debit: number;
    credit: number;
    runningBalance: number;
    hasReceiptMatch: boolean;
  }>;
  totalDebit: number;
  totalCredit: number;
  endingBalance: number;
  accounts: Array<{ id: string; accountNumber: string; accountName: string; accountType: string | null }>;
  /** When set, transaction-detail links carry these so the deeper page's
   *  breadcrumb keeps pointing to whatever brought the user here. */
  forwardBack: string | null;
  forwardBackLabel: string | null;
}) {
  const txnHref = (id: string): string => {
    const params: string[] = [];
    if (forwardBack) params.push(`back=${encodeURIComponent(forwardBack)}`);
    if (forwardBackLabel) params.push(`backLabel=${encodeURIComponent(forwardBackLabel)}`);
    return params.length > 0 ? `/transactions/${id}?${params.join('&')}` : `/transactions/${id}`;
  };
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Transactions
        </h2>
        <span className="text-xs text-zinc-500">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </header>

      <div className="px-4 py-3">
        <BulkBar accounts={accounts} />
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="w-10 px-4 py-2">
              <SelectAllCheckbox formId="bulk-form" />
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Bank account</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">JE</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Debit</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Credit</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-6 text-center text-zinc-500">
                No transactions hitting this account in the period.
              </td>
            </tr>
          )}
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              <td className="px-4 py-2">
                <input type="checkbox" name="ids" value={t.id} form="bulk-form" className="h-4 w-4" />
              </td>
              <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                <Link href={txnHref(t.id)} className="hover:underline">
                  {t.date ?? '—'}
                </Link>
              </td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                <div className="flex flex-wrap items-center gap-1.5">
                  {t.hasReceiptMatch && (
                    <span className="inline-flex items-center rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                      Linked Receipt
                    </span>
                  )}
                  <span>{t.bankDescription ?? t.description ?? '—'}</span>
                </div>
              </td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.contactName ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.bankAccountName ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                {t.journalEntryId ? '✓' : <span className="text-amber-600">—</span>}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {t.debit > 0 ? fmt(t.debit) : ''}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {t.credit > 0 ? fmt(t.credit) : ''}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {fmt(t.runningBalance)}
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot className="bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
              <td colSpan={6} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                Total · ending balance
              </td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(totalDebit)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(totalCredit)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(endingBalance)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </section>
  );
}

function InvoicesSection({
  accountId,
  accounts,
  rows,
  total,
}: {
  accountId: string;
  accounts: Array<{ id: string; accountNumber: string; accountName: string; accountType: string | null }>;
  rows: Array<{
    id: string;
    invoiceNumber: string | null;
    invoiceDate: string;
    status: string;
    contactName: string | null;
    jeId: string;
    amount: number;
  }>;
  total: number;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Invoices
        </h2>
        <span className="text-xs text-zinc-500">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </header>

      <div className="px-4 py-3">
        <SourceDocBulkBar
          formId="invoice-bulk-form"
          fromAccountId={accountId}
          accounts={accounts}
          noun="invoices"
        />
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="w-10 px-4 py-2">
              <SelectAllCheckbox formId="invoice-bulk-form" />
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Number</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Customer</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              On this account
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              <td className="px-4 py-2">
                <input
                  type="checkbox"
                  name="journalEntryIds"
                  value={r.jeId}
                  form="invoice-bulk-form"
                  className="h-4 w-4"
                />
              </td>
              <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.invoiceDate}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                <Link href={`/invoices/${r.id}`} className="hover:underline">
                  {r.invoiceNumber ?? r.id.slice(0, 8)}
                </Link>
              </td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.contactName ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.status}</td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {fmt(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Total on this account
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function BillsSection({
  accountId,
  accounts,
  rows,
  total,
}: {
  accountId: string;
  accounts: Array<{ id: string; accountNumber: string; accountName: string; accountType: string | null }>;
  rows: Array<{
    id: string;
    billNumber: string | null;
    billDate: string;
    status: string;
    contactName: string | null;
    jeId: string;
    amount: number;
  }>;
  total: number;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Bills
        </h2>
        <span className="text-xs text-zinc-500">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </header>

      <div className="px-4 py-3">
        <SourceDocBulkBar
          formId="bill-bulk-form"
          fromAccountId={accountId}
          accounts={accounts}
          noun="bills"
        />
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="w-10 px-4 py-2">
              <SelectAllCheckbox formId="bill-bulk-form" />
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Number</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Vendor</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              On this account
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              <td className="px-4 py-2">
                <input
                  type="checkbox"
                  name="journalEntryIds"
                  value={r.jeId}
                  form="bill-bulk-form"
                  className="h-4 w-4"
                />
              </td>
              <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.billDate}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                <Link href={`/bills/${r.id}`} className="hover:underline">
                  {r.billNumber ?? r.id.slice(0, 8)}
                </Link>
              </td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.contactName ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.status}</td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                {fmt(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Total on this account
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
