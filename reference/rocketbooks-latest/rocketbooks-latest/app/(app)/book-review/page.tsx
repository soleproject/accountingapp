import Link from 'next/link';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { bookReviewFindings, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { FindingActions } from './_components/FindingActions';

const KINDS = ['duplicate', 'integrity', 'anomaly'] as const;
type KindFilter = (typeof KINDS)[number];

const CODE_META: Record<string, { title: string }> = {
  DUP_EXACT: { title: 'Likely duplicate transactions' },
  DUP_NEAR: { title: 'Possible near-duplicates' },
  BAL_UNBALANCED: { title: "Trial balance doesn't tie out" },
  BAL_ORPHAN_TXN: { title: 'Categorized but not posted to the ledger' },
  BAL_ORPHAN_GL: { title: 'Posted entries missing from the ledger' },
  ANOM_AMOUNT_OUTLIER: { title: 'Unusual amounts' },
  ANOM_CATEGORY_DRIFT: { title: 'Possible miscategorizations' },
};

interface PageProps {
  searchParams: Promise<{ kind?: string }>;
}

function fmtAmount(n: number | null): string {
  if (n == null) return '—';
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TxnLite {
  id: string;
  date: string;
  amount: number | null;
  description: string | null;
  type: string | null;
}

export default async function BookReviewPage(props: PageProps) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const sp = await props.searchParams;
  const kind: KindFilter | undefined = (KINDS as readonly string[]).includes(sp.kind ?? '')
    ? (sp.kind as KindFilter)
    : undefined;

  const findings = await db
    .select({
      id: bookReviewFindings.id,
      kind: bookReviewFindings.kind,
      code: bookReviewFindings.code,
      severity: bookReviewFindings.severity,
      message: bookReviewFindings.message,
      transactionId: bookReviewFindings.transactionId,
      relatedTransactionId: bookReviewFindings.relatedTransactionId,
      createdAt: bookReviewFindings.createdAt,
    })
    .from(bookReviewFindings)
    .where(
      and(
        eq(bookReviewFindings.organizationId, orgId),
        eq(bookReviewFindings.status, 'open'),
        kind ? eq(bookReviewFindings.kind, kind) : undefined,
      ),
    )
    .orderBy(
      asc(sql`case when ${bookReviewFindings.severity} = 'warn' then 0 else 1 end`),
      desc(bookReviewFindings.createdAt),
    );

  // Fetch the transactions referenced by these findings in one query.
  const txnIds = Array.from(
    new Set(
      findings.flatMap((f) => [f.transactionId, f.relatedTransactionId].filter((x): x is string => !!x)),
    ),
  );
  const txnMap = new Map<string, TxnLite>();
  if (txnIds.length > 0) {
    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        description: transactions.description,
        type: transactions.type,
      })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, txnIds)));
    for (const r of rows) txnMap.set(r.id, r);
  }

  // Group findings by code, preserving the severity/date order above.
  const groups: { code: string; items: typeof findings }[] = [];
  for (const f of findings) {
    let g = groups.find((x) => x.code === f.code);
    if (!g) {
      g = { code: f.code, items: [] };
      groups.push(g);
    }
    g.items.push(f);
  }

  const tabs: { label: string; value?: KindFilter }[] = [
    { label: 'All' },
    { label: 'Duplicates', value: 'duplicate' },
    { label: 'Integrity', value: 'integrity' },
    { label: 'Anomalies', value: 'anomaly' },
  ];

  function txnLine(t: TxnLite | undefined): string {
    if (!t) return 'transaction';
    const desc = t.description ? ` · ${t.description}` : '';
    return `${t.date} · ${fmtAmount(t.amount)}${desc}`;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-2 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Book review</h1>
        <span className="text-sm text-zinc-500">{findings.length} open</span>
      </div>
      <p className="mb-6 text-sm text-zinc-500">
        Possible duplicates and bookkeeping-integrity issues found in your books. Reversing a duplicate
        undoes its ledger impact without deleting the record.
      </p>

      <div className="mb-6 flex gap-2">
        {tabs.map((t) => {
          const active = (t.value ?? undefined) === kind;
          const href = t.value ? `/book-review?kind=${t.value}` : '/book-review';
          return (
            <Link
              key={t.label}
              href={href}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      {findings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nothing to review — your books look clean. ✓
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.code}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                {CODE_META[g.code]?.title ?? g.code} ({g.items.length})
              </h2>
              <div className="space-y-3">
                {g.items.map((f) => {
                  const a = f.transactionId ? txnMap.get(f.transactionId) : undefined;
                  const b = f.relatedTransactionId ? txnMap.get(f.relatedTransactionId) : undefined;
                  const options =
                    f.kind === 'duplicate'
                      ? [a, b]
                          .filter((t): t is TxnLite => !!t)
                          .map((t) => ({ id: t.id, label: `the ${t.date} entry` }))
                      : [];
                  return (
                    <div
                      key={f.id}
                      className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-zinc-900 dark:text-zinc-100">{f.message}</p>
                        {f.kind === 'duplicate' && (a || b) && (
                          <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                            {a && (
                              <li>
                                <Link href={`/transactions/${a.id}`} className="hover:underline">
                                  {txnLine(a)}
                                </Link>
                              </li>
                            )}
                            {b && (
                              <li>
                                <Link href={`/transactions/${b.id}`} className="hover:underline">
                                  {txnLine(b)}
                                </Link>
                              </li>
                            )}
                          </ul>
                        )}
                        {f.kind !== 'duplicate' && f.transactionId && (
                          <Link
                            href={`/transactions/${f.transactionId}`}
                            className="mt-1 inline-block text-xs text-zinc-500 hover:underline"
                          >
                            View transaction →
                          </Link>
                        )}
                      </div>
                      <FindingActions
                        findingId={f.id}
                        kind={f.kind === 'duplicate' ? 'duplicate' : 'integrity'}
                        options={options}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
