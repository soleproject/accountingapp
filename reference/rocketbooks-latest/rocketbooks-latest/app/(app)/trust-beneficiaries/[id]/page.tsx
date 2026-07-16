import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  trustBeneficiaries,
  trustDobCorrectionJobs,
  journalEntries,
  journalEntryLines,
  chartOfAccounts,
  transactions,
  contacts,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { BeneficiaryLineFilters } from './_components/BeneficiaryLineFilters';
import { ViewToggle } from './_components/ViewToggle';
import { IncapacitationCard } from './_components/IncapacitationCard';
import { DobCorrectionProgressPill } from '../_components/DobCorrectionProgressPill';
import type { DobCorrectionJobStatus } from '../_actions/getDobCorrectionJobStatus';
import {
  TaggedTransactionRow,
  type TaggedTransactionCardData,
  type BeneficiaryOption,
} from './_components/TaggedTransactionCard';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FOOD_OR_CLOTHING_DETAIL_TYPES = new Set<string>([
  'trust_food_minors_incapacitated',
  'trust_clothing_minors_incapacitated',
]);

function ageYearsFromDob(dob: string, asOfDate: string): number | null {
  const birth = new Date(dob);
  const as = new Date(asOfDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
  let years = as.getUTCFullYear() - birth.getUTCFullYear();
  const m = as.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
  return years;
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    q?: string;
    accountId?: string;
    side?: string;
    start?: string;
    end?: string;
    view?: string;
  }>;
}

export default async function BeneficiaryDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const orgId = await getCurrentOrgId();

  const filters = {
    q: (sp.q ?? '').trim(),
    accountId: (sp.accountId ?? '').trim(),
    side: (sp.side === 'debit' || sp.side === 'credit' ? sp.side : '') as '' | 'debit' | 'credit',
    start: DATE_RE.test(sp.start ?? '') ? (sp.start as string) : '',
    end: DATE_RE.test(sp.end ?? '') ? (sp.end as string) : '',
  };
  const view: 'lines' | 'txns' = sp.view === 'txns' ? 'txns' : 'lines';
  const hasAnyFilter =
    !!filters.q ||
    !!filters.accountId ||
    !!filters.side ||
    !!filters.start ||
    !!filters.end;

  // preservedQuery keeps the filter params when the user flips between
  // Lines and Transactions via the toggle.
  const preservedParams = new URLSearchParams();
  if (filters.q) preservedParams.set('q', filters.q);
  if (filters.accountId) preservedParams.set('accountId', filters.accountId);
  if (filters.side) preservedParams.set('side', filters.side);
  if (filters.start) preservedParams.set('start', filters.start);
  if (filters.end) preservedParams.set('end', filters.end);
  const preservedQuery = preservedParams.toString();

  const [bene] = await db
    .select({
      id: trustBeneficiaries.id,
      fullName: trustBeneficiaries.fullName,
      dateOfBirth: trustBeneficiaries.dateOfBirth,
      isIncapacitated: trustBeneficiaries.isIncapacitated,
      incapacitatedSince: trustBeneficiaries.incapacitatedSince,
      notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
      relationship: trustBeneficiaries.relationship,
    })
    .from(trustBeneficiaries)
    .where(and(eq(trustBeneficiaries.id, id), eq(trustBeneficiaries.organizationId, orgId)))
    .limit(1);
  if (!bene) notFound();

  // Server-rendered initial snapshot of the most recent DOB-correction
  // job for this beneficiary. The polling pill on the client takes it
  // from here and keeps polling while the job is queued/running.
  const [latestJob] = await db
    .select({
      id: trustDobCorrectionJobs.id,
      beneficiaryId: trustDobCorrectionJobs.beneficiaryId,
      status: trustDobCorrectionJobs.status,
      progress: trustDobCorrectionJobs.progress,
      totalCount: trustDobCorrectionJobs.totalCount,
      repostedCount: trustDobCorrectionJobs.repostedCount,
      failedCount: trustDobCorrectionJobs.failedCount,
      errorMessage: trustDobCorrectionJobs.errorMessage,
      newDob: trustDobCorrectionJobs.newDob,
      createdAt: trustDobCorrectionJobs.createdAt,
      completedAt: trustDobCorrectionJobs.completedAt,
    })
    .from(trustDobCorrectionJobs)
    .where(
      and(
        eq(trustDobCorrectionJobs.beneficiaryId, bene.id),
        eq(trustDobCorrectionJobs.organizationId, orgId),
      ),
    )
    .orderBy(desc(trustDobCorrectionJobs.createdAt))
    .limit(1);
  const initialJob: DobCorrectionJobStatus | null = latestJob
    ? {
        ...latestJob,
        status:
          (['queued', 'running', 'completed', 'failed'] as const).includes(
            latestJob.status as 'queued',
          )
            ? (latestJob.status as DobCorrectionJobStatus['status'])
            : 'failed',
      }
    : null;

  // All JE lines tagged with this beneficiary, joined with the source
  // transaction (when sourceType='transaction') so the card view can
  // expose vendor + open-txn link without a second round-trip.
  const allLines = await db
    .select({
      lineId: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      detailType: chartOfAccounts.detailType,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      jeDate: journalEntries.date,
      jeMemo: journalEntries.memo,
      jeSourceType: journalEntries.sourceType,
      jeSourceId: journalEntries.sourceId,
      txnId: transactions.id,
      txnAmount: transactions.amount,
      txnContactId: transactions.contactId,
      txnBankDescription: transactions.bankDescription,
      txnBankAccountId: transactions.accountId,
      txnUserDescription: transactions.userDescription,
      vendorName: contacts.contactName,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
    .leftJoin(transactions, eq(transactions.id, journalEntries.sourceId))
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(
      and(
        eq(journalEntryLines.beneficiaryId, id),
        eq(journalEntries.organizationId, orgId),
        // Exclude lines on reversal counter-entries AND on JEs that have
        // been reversed by a later counter — both sides of the pair are
        // logically dead and would otherwise inflate the by-account
        // totals after every reroute cycle.
        isNull(journalEntries.reversalOfId),
        sql`NOT EXISTS (SELECT 1 FROM journal_entries cnt WHERE cnt.reversal_of_id = ${journalEntries.id})`,
      ),
    )
    .orderBy(desc(journalEntries.date), desc(journalEntries.createdAt));

  // Account dropdown options derived from the data.
  const accountMap = new Map<string, { id: string; accountNumber: string | null; accountName: string }>();
  for (const l of allLines) {
    if (!accountMap.has(l.accountId)) {
      accountMap.set(l.accountId, {
        id: l.accountId,
        accountNumber: l.accountNumber,
        accountName: l.accountName,
      });
    }
  }
  const accountOptions = Array.from(accountMap.values()).sort((a, b) =>
    (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''),
  );

  // Apply filters.
  const qLower = filters.q.toLowerCase();
  const filteredLines = allLines.filter((l) => {
    if (filters.accountId && l.accountId !== filters.accountId) return false;
    if (filters.side === 'debit' && Number(l.debit) <= 0) return false;
    if (filters.side === 'credit' && Number(l.credit) <= 0) return false;
    if (filters.start && l.jeDate < filters.start) return false;
    if (filters.end && l.jeDate > filters.end) return false;
    if (qLower) {
      const hay = `${l.memo ?? ''} ${l.jeMemo ?? ''} ${l.txnBankDescription ?? ''} ${l.vendorName ?? ''}`.toLowerCase();
      if (!hay.includes(qLower)) return false;
    }
    return true;
  });

  // Summary panel always reflects unfiltered data — legend for quick nav.
  const byAccount = new Map<
    string,
    { accountNumber: string | null; accountName: string; count: number; net: number }
  >();
  for (const l of allLines) {
    const key = `${l.accountNumber ?? ''}|${l.accountName}`;
    const cur = byAccount.get(key) ?? {
      accountNumber: l.accountNumber,
      accountName: l.accountName,
      count: 0,
      net: 0,
    };
    cur.count += 1;
    cur.net += Number(l.debit) - Number(l.credit);
    byAccount.set(key, cur);
  }
  const summary = Array.from(byAccount.values()).sort((a, b) =>
    (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''),
  );

  const filteredTotal = filteredLines.reduce(
    (acc, l) => acc + Number(l.debit) - Number(l.credit),
    0,
  );

  // Extra fetches only when the Transactions view is active — keeps the
  // Lines view query budget minimal.
  let contactOptions: Array<{ id: string; name: string }> = [];
  let beneficiaryOptions: BeneficiaryOption[] = [];
  if (view === 'txns') {
    const [contactRows, beneRows] = await Promise.all([
      db
        .select({ id: contacts.id, name: contacts.contactName })
        .from(contacts)
        .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
        .orderBy(asc(contacts.contactName)),
      db
        .select({
          id: trustBeneficiaries.id,
          fullName: trustBeneficiaries.fullName,
          dateOfBirth: trustBeneficiaries.dateOfBirth,
          isIncapacitated: trustBeneficiaries.isIncapacitated,
        })
        .from(trustBeneficiaries)
        .where(eq(trustBeneficiaries.organizationId, orgId))
        .orderBy(asc(trustBeneficiaries.fullName)),
    ]);
    contactOptions = contactRows;
    const today = new Date().toISOString().slice(0, 10);
    beneficiaryOptions = beneRows.map((b) => {
      const ageYears = b.dateOfBirth ? ageYearsFromDob(b.dateOfBirth, today) : null;
      const qualifies = b.isIncapacitated || (ageYears !== null && ageYears < 21);
      const ageNote = b.isIncapacitated
        ? 'incapacitated'
        : ageYears !== null
          ? `age ${ageYears}`
          : 'age unknown';
      return { id: b.id, fullName: b.fullName, qualifies, ageNote };
    });
  }

  // Resolve bank-account labels (only when the txn view will render — the
  // Lines view doesn't need them).
  let bankAccountLabels = new Map<string, string>();
  if (view === 'txns') {
    const bankIds = Array.from(
      new Set(
        filteredLines
          .map((l) => l.txnBankAccountId)
          .filter((v): v is string => !!v),
      ),
    );
    if (bankIds.length > 0) {
      const bankRows = await db
        .select({
          id: chartOfAccounts.id,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
        })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.organizationId, orgId),
            inArray(chartOfAccounts.id, bankIds),
          ),
        );
      bankAccountLabels = new Map(
        bankRows.map((b) => [
          b.id,
          b.accountNumber ? `${b.accountNumber} · ${b.accountName}` : b.accountName,
        ]),
      );
    }
  }

  const cards: TaggedTransactionCardData[] = filteredLines.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    const side: 'debit' | 'credit' = debit > 0 ? 'debit' : 'credit';
    const amount = Math.max(debit, credit);
    const bankAccountLabel = l.txnBankAccountId
      ? bankAccountLabels.get(l.txnBankAccountId) ?? null
      : null;
    return {
      transactionId: l.txnId ?? null,
      journalEntryId: l.journalEntryId,
      lineId: l.lineId,
      date: l.jeDate,
      amount,
      side,
      accountNumber: l.accountNumber,
      accountName: l.accountName,
      bankAccountLabel,
      vendorContactId: l.txnContactId ?? null,
      vendorName: l.vendorName ?? null,
      bankDescription: l.txnBankDescription ?? null,
      memo: l.memo ?? l.jeMemo ?? null,
      description: l.txnUserDescription ?? null,
      beneficiaryId: id,
      requiresQualifying: !!l.detailType && FOOD_OR_CLOTHING_DETAIL_TYPES.has(l.detailType),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <DobCorrectionProgressPill beneficiaryId={bene.id} initialJob={initialJob} />
      <Link
        href="/trust-beneficiaries"
        className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        ← Back to beneficiaries
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">{bene.fullName}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {bene.relationship ?? '—'}
          {bene.dateOfBirth && <> · DOB {bene.dateOfBirth}</>}
          {bene.isIncapacitated && <> · incapacitated</>}
          {' · '}
          {allLines.length.toLocaleString()} tagged line{allLines.length === 1 ? '' : 's'}
        </p>
      </header>

      <IncapacitationCard
        beneficiaryId={bene.id}
        beneficiaryName={bene.fullName}
        dateOfBirth={bene.dateOfBirth}
        relationship={bene.relationship}
        isIncapacitated={bene.isIncapacitated}
        incapacitatedSince={bene.incapacitatedSince}
        notIncapacitatedSince={bene.notIncapacitatedSince}
      />

      {summary.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
            By account
          </h2>
          <div className="overflow-hidden rounded-xl border border-zinc-400 bg-white shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-blue-500/60 hover:ring-2 hover:ring-blue-500/70 dark:border-zinc-500 dark:bg-zinc-800 dark:shadow-black/60 dark:ring-white/10 dark:hover:shadow-blue-400/60 dark:hover:ring-blue-400/60">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Lines</th>
                  <th className="px-4 py-2 text-right font-medium">Net (Dr − Cr)</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr
                    key={`${s.accountNumber}-${s.accountName}`}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                      <span className="font-mono text-xs text-zinc-500">
                        {s.accountNumber ?? '—'}
                      </span>{' '}
                      {s.accountName}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                      {s.count.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                      {CURRENCY_FMT.format(Math.round(s.net * 100) / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {view === 'txns' ? 'Transactions' : 'Lines'}
          </h2>
          <ViewToggle current={view} preservedQuery={preservedQuery} />
        </div>

        <BeneficiaryLineFilters accounts={accountOptions} selected={filters} />

        {hasAnyFilter && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Showing {filteredLines.length.toLocaleString()} of{' '}
            {allLines.length.toLocaleString()} {view === 'txns' ? 'cards' : 'lines'} · filtered net{' '}
            <span className="tabular-nums">
              {CURRENCY_FMT.format(Math.round(filteredTotal * 100) / 100)}
            </span>
          </div>
        )}

        {view === 'txns' ? (
          cards.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
              {hasAnyFilter ? 'No transactions match the current filters.' : 'No tagged transactions yet.'}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {cards.map((c) => (
                <TaggedTransactionRow
                  key={c.lineId}
                  data={c}
                  contacts={contactOptions}
                  beneficiaries={beneficiaryOptions}
                />
              ))}
            </div>
          )
        ) : filteredLines.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
            {hasAnyFilter ? 'No lines match the current filters.' : 'No tagged journal-entry lines yet.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Memo</th>
                  <th className="px-4 py-2 text-right font-medium">Debit</th>
                  <th className="px-4 py-2 text-right font-medium">Credit</th>
                  <th className="px-4 py-2 font-medium">JE</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.map((l) => {
                  const debit = Number(l.debit);
                  const credit = Number(l.credit);
                  const txnHref =
                    l.jeSourceType === 'transaction' && l.jeSourceId
                      ? `/transactions/${l.jeSourceId}`
                      : null;
                  return (
                    <tr key={l.lineId} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
                        {l.jeDate}
                      </td>
                      <td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
                        <span className="font-mono text-xs text-zinc-500">
                          {l.accountNumber ?? '—'}
                        </span>{' '}
                        {l.accountName}
                      </td>
                      <td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
                        {l.memo ?? l.jeMemo ?? '—'}
                        {txnHref && (
                          <>
                            {' · '}
                            <Link href={txnHref} className="text-blue-600 hover:underline dark:text-blue-400">
                              view txn
                            </Link>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                        {debit > 0 ? CURRENCY_FMT.format(debit) : ''}
                      </td>
                      <td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                        {credit > 0 ? CURRENCY_FMT.format(credit) : ''}
                      </td>
                      <td className="px-4 py-2 align-top">
                        <Link
                          href={`/journal-entries/${l.journalEntryId}`}
                          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
