import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, inArray, asc, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptLines, contacts, chartOfAccounts, receiptMatchSuggestions, receiptMatchApplications, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { ReceiptLinesEditor, type AccountOption, type ReceiptLineRow } from '../_components/ReceiptLinesEditor';
import { ReceiptMatchesPanel, type MatchCandidate } from '../_components/ReceiptMatchesPanel';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ showMatches?: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// Asset-style account types that are sensible "paid from" picks. Kept
// permissive on purpose — owners credit owner's-funds equity, businesses
// credit cash/CC liabilities. resolve-pfc-coa.ts uses a similar split.
const SOURCE_GAAP_TYPES = ['asset', 'liability', 'equity'] as const;
const EXPENSE_GAAP_TYPES = ['expense', 'cost_of_goods_sold'] as const;

export default async function ReceiptDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { showMatches } = await searchParams;
  const orgId = await getCurrentOrgId();

  const [r] = await db
    .select({
      id: receipts.id,
      receiptDate: receipts.receiptDate,
      memo: receipts.memo,
      totalAmount: receipts.totalAmount,
      status: receipts.status,
      posted: receipts.posted,
      journalEntryId: receipts.journalEntryId,
      veryfiDocumentId: receipts.veryfiDocumentId,
      veryfiRawJson: receipts.veryfiRawJson,
      rawText: receipts.rawText,
      contactName: contacts.contactName,
      sourceAccountId: receipts.sourceAccountId,
    })
    .from(receipts)
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(and(eq(receipts.id, id), eq(receipts.organizationId, orgId)))
    .limit(1);
  if (!r) notFound();

  // Veryfi's response carries signed image URLs we never re-host. They
  // expire ~24h after upload, so the preview works for fresh receipts
  // and the <img> falls back to its onError placeholder for older rows.
  let imageUrl: string | null = null;
  let pdfUrl: string | null = null;
  if (r.veryfiRawJson) {
    try {
      const parsed = JSON.parse(r.veryfiRawJson) as { img_url?: string; img_thumbnail_url?: string; pdf_url?: string };
      imageUrl = parsed.img_url ?? parsed.img_thumbnail_url ?? null;
      pdfUrl = parsed.pdf_url ?? null;
    } catch {
      // bad json — skip preview
    }
  }

  const [lineRows, accountRows, matchRows] = await Promise.all([
    db
      .select({
        id: receiptLines.id,
        description: receiptLines.description,
        amount: receiptLines.amount,
        expenseAccountId: receiptLines.expenseAccountId,
        suggestedAccountId: receiptLines.suggestedAccountId,
      })
      .from(receiptLines)
      .where(eq(receiptLines.receiptId, id))
      .orderBy(asc(receiptLines.id)),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          eq(chartOfAccounts.isActive, true),
          inArray(chartOfAccounts.gaapType, [...EXPENSE_GAAP_TYPES, ...SOURCE_GAAP_TYPES]),
        ),
      )
      .orderBy(asc(chartOfAccounts.accountNumber)),
    // Match suggestions for this receipt — both pending (need review)
    // and auto_applied (need verify/undo). Joined to transaction detail
    // and (for auto-applied rows) the application row so we have the
    // app id for the undo action without a second round-trip.
    db
      .select({
        suggestionId: receiptMatchSuggestions.id,
        status: receiptMatchSuggestions.status,
        confidence: receiptMatchSuggestions.confidence,
        amountDiff: receiptMatchSuggestions.amountDiff,
        dateDiffDays: receiptMatchSuggestions.dateDiffDays,
        vendorMatch: receiptMatchSuggestions.vendorMatch,
        applicationId: receiptMatchApplications.id,
        appReversedAt: receiptMatchApplications.reversedAt,
        transactionId: transactions.id,
        transactionDate: transactions.date,
        transactionAmount: transactions.amount,
        transactionDescription: transactions.description,
        accountName: chartOfAccounts.accountName,
        contactName: contacts.contactName,
      })
      .from(receiptMatchSuggestions)
      .innerJoin(transactions, eq(receiptMatchSuggestions.transactionId, transactions.id))
      .leftJoin(chartOfAccounts, eq(transactions.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .leftJoin(receiptMatchApplications, eq(receiptMatchApplications.suggestionId, receiptMatchSuggestions.id))
      .where(
        and(
          eq(receiptMatchSuggestions.receiptId, id),
          eq(receiptMatchSuggestions.organizationId, orgId),
          sql`${receiptMatchSuggestions.status} IN ('pending', 'auto_applied')`,
        ),
      )
      .orderBy(desc(receiptMatchSuggestions.confidence)),
  ]);

  // If this receipt already has an active match, surface the linked
  // transaction id so the dropdown can pre-select it and disable the
  // picker (re-link via Undo + Accept-different on the panel above).
  const [activeAppRow] = await db
    .select({ transactionId: receiptMatchApplications.transactionId })
    .from(receiptMatchApplications)
    .where(
      and(
        eq(receiptMatchApplications.receiptId, id),
        eq(receiptMatchApplications.organizationId, orgId),
        sql`${receiptMatchApplications.reversedAt} IS NULL`,
      ),
    )
    .limit(1);
  const linkedTransactionId = activeAppRow?.transactionId ?? null;

  // Candidate transactions for the manual link dropdown. Limit to txns
  // not currently linked to ANY receipt via an active application — once
  // it's matched somewhere, surfacing it here would be misleading. We
  // include posted-or-unposted, any direction; the user has knowledge
  // the matcher doesn't.
  const txnCandidates = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      description: transactions.description,
      bankDescription: transactions.bankDescription,
      contactName: contacts.contactName,
    })
    .from(transactions)
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        sql`NOT EXISTS (
          SELECT 1 FROM receipt_match_applications rma
          WHERE rma.transaction_id = ${transactions.id}
            AND rma.reversed_at IS NULL
        )`,
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(200);

  const expenseAccounts: AccountOption[] = accountRows.filter((a) =>
    (EXPENSE_GAAP_TYPES as readonly string[]).includes(a.gaapType),
  );
  const sourceAccounts: AccountOption[] = accountRows.filter((a) =>
    (SOURCE_GAAP_TYPES as readonly string[]).includes(a.gaapType),
  );

  const lines: ReceiptLineRow[] = lineRows.map((l) => ({
    id: l.id,
    description: l.description,
    amount: Number(l.amount),
    expenseAccountId: l.expenseAccountId,
    suggestedAccountId: l.suggestedAccountId,
  }));

  const matches: MatchCandidate[] = matchRows
    // The leftJoin on receipt_match_applications can return the row both
    // before and after a reversal; filter out reversed applications so the
    // panel sees a clean current-state snapshot.
    .filter((m) => m.status === 'pending' || (m.status === 'auto_applied' && !m.appReversedAt))
    .map((m) => ({
      suggestionId: m.suggestionId,
      status: m.status as 'pending' | 'auto_applied',
      applicationId: m.applicationId,
      confidence: Number(m.confidence),
      amountDiff: Number(m.amountDiff),
      dateDiffDays: m.dateDiffDays,
      vendorMatch: m.vendorMatch,
      transactionId: m.transactionId,
      transactionDate: m.transactionDate,
      transactionAmount: Number(m.transactionAmount ?? 0),
      transactionDescription: m.transactionDescription,
      accountName: m.accountName,
      contactName: m.contactName,
    }));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/receipts" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to receipts
      </Link>
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{r.contactName ?? 'Receipt'}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {r.receiptDate} · {r.posted ? 'Posted' : r.status}
            {r.journalEntryId && (<>{' · '}<Link href={`/journal-entries/${r.journalEntryId}`} className="underline">View JE</Link></>)}
            {r.veryfiDocumentId && (<>{' · '}<span className="font-mono text-xs">Veryfi #{r.veryfiDocumentId}</span></>)}
          </p>
        </div>
        <div className="text-2xl font-semibold tabular-nums">{fmt(Number(r.totalAmount))}</div>
      </header>

      <ReceiptMatchesPanel matches={matches} autoOpen={showMatches === '1'} />

      <ReceiptLinesEditor
        receiptId={r.id}
        posted={r.posted}
        sourceAccountId={r.sourceAccountId}
        lines={lines}
        expenseAccounts={expenseAccounts}
        sourceAccounts={sourceAccounts}
        imageUrl={imageUrl}
        pdfUrl={pdfUrl}
        txnCandidates={txnCandidates.map((t) => ({
          id: t.id,
          date: t.date,
          amount: Number(t.amount ?? 0),
          description: t.description ?? t.bankDescription ?? null,
          contactName: t.contactName,
        }))}
        linkedTransactionId={linkedTransactionId}
      />

      {r.memo && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</h2>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{r.memo}</p>
        </section>
      )}

      {r.rawText && (
        <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-zinc-500">
            OCR text
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-900">
            {r.rawText}
          </pre>
        </details>
      )}
    </div>
  );
}
