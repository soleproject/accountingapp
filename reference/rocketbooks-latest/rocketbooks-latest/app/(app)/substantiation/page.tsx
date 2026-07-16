import Link from 'next/link';
import { requirePermission, hasAnyPermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { findTxnsNeedingSubstantiation, listSubstantiationRecords } from '@/lib/accounting/substantiation';
import { specFor, askFields, type DocType } from '@/lib/accounting/substantiation-types';
import { requestSubstantiationAction } from './_actions/request';
import { NotifyActionButton } from '@/components/ai-assistant/NotifyActionButton';
import { SubstantiationForm, type SubstItem } from './_components/SubstantiationForm';

/**
 * IRS Documentation — the substantiation store. Surfaces transactions that need
 * IRS-required documentation (meals, travel, gifts, vehicle, charitable), lets
 * the client fill in the exact required fields per transaction right on the page
 * (or reply to the request email), and shows what's on file linked to each txn.
 */
const fmt = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const STATUS_TONE: Record<string, string> = {
  provided: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  requested: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  needed: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

/** Build a fill-in card item from a transaction + any already-provided fields. */
function buildItem(
  txnId: string,
  docType: DocType,
  date: string | null,
  amount: number | null,
  description: string | null,
  fields: Record<string, unknown> | null,
): SubstItem {
  const spec = specFor(docType);
  // Required fields first, optional ones at the bottom of the card.
  const ask = askFields(spec);
  const ordered = [...ask.filter((f) => !f.optional), ...ask.filter((f) => f.optional)];
  const values: Record<string, string> = {};
  if (fields) {
    for (const f of ordered) {
      const v = fields[f.key];
      if (v != null && v !== '') values[f.key] = String(v);
    }
  }
  return {
    transactionId: txnId,
    docType,
    docLabel: spec.label,
    date,
    amount,
    description,
    askFields: ordered.map((f) => ({ key: f.key, label: f.label, optional: f.optional })),
    values,
  };
}

export default async function SubstantiationPage() {
  await requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const canRequest = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);

  const [needing, records] = await Promise.all([
    findTxnsNeedingSubstantiation(orgId, 30),
    listSubstantiationRecords(orgId),
  ]);

  // Anything still missing required info gets a fill-in card: transactions with no
  // record yet (blank) + requested/partial records (prefilled). Completed → On file.
  const pending: SubstItem[] = [
    ...needing.map((n) => buildItem(n.txnId, n.docType, n.date, n.amount, n.description, null)),
    ...records
      .filter((r) => r.status !== 'provided')
      .map((r) => buildItem(r.transactionId, r.docType, r.date, r.amount, r.description, r.fields ?? null)),
  ];
  const onFile = records.filter((r) => r.status === 'provided');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">IRS Documentation</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Substantiation the IRS requires for certain transactions (meals, travel, gifts, vehicle, charitable) —
            fill in the details for each below, or reply to the request email. Filed with each transaction.
          </p>
        </div>
        {canRequest && needing.length > 0 && (
          <NotifyActionButton
            action={requestSubstantiationAction}
            message={`Emailed the client for IRS documentation on the ${needing.length} transaction${needing.length === 1 ? '' : 's'} that need it. As replies come in we'll attach the details to each transaction so the deductions are substantiated.`}
            className="rounded-md border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
            title="Email the client for the IRS details on the transactions that need it"
          >
            ✉️ Request documentation from client
          </NotifyActionButton>
        )}
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Needs documentation ({pending.length})
        </h2>
        <SubstantiationForm items={pending} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">On file ({onFile.length})</h2>
        {onFile.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nothing on file yet. Details you save above (or client email replies) are filed here automatically.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {onFile.map((r) => {
              const spec = specFor(r.docType);
              return (
                <div key={r.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm">
                      <Link href={`/transactions/${r.transactionId}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">{r.description ?? 'Transaction'}</Link>
                      <span className="text-zinc-500"> · {r.date ?? ''} · {fmt(r.amount)} · {spec.label}</span>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[r.status] ?? STATUS_TONE.needed}`}>{r.status}</span>
                  </div>
                  {r.fields && Object.keys(r.fields).length > 0 && (
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                      {spec.fields.map((f) => {
                        const v = r.fields?.[f.key];
                        if (v == null || v === '') return null;
                        return (
                          <div key={f.key} className="text-xs">
                            <dt className="inline font-medium text-zinc-500">{f.label}: </dt>
                            <dd className="inline text-zinc-700 dark:text-zinc-300">{String(v)}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="text-xs text-zinc-400">
        The exact IRS-required fields per type (Pub 463 / §274(d); Pub 526 / §170) are filed with each transaction.
        Off by default; enable scheduled requests in Settings.
      </p>
    </div>
  );
}
