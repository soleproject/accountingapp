import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import { resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { loadSalesTaxLiability } from '@/lib/reports/sales-tax-data';

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; basis?: string }>;
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default async function SalesTaxPage({ searchParams }: PageProps) {
  await requirePermission('accounting.reports.view');
  const orgId = await getCurrentOrgId();
  const { from, to, basis: basisParam } = await searchParams;
  const fromDate = safeIsoDate(from, yearStartIso());
  const toDate = safeIsoDate(to, todayIso());
  const basis = await resolveBasis(orgId, basisParam);

  const data = await loadSalesTaxLiability(orgId, fromDate, toDate, basis);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales Tax Liability</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Tax collected vs. remitted, {fromDate} → {toDate}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <BasisToggle basis={basis} />
          <form className="flex items-center gap-2">
            <label className="text-xs text-zinc-500">From</label>
            <input type="date" name="from" defaultValue={fromDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            <label className="text-xs text-zinc-500">To</label>
            <input type="date" name="to" defaultValue={toDate} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            <input type="hidden" name="basis" value={basis} />
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Apply</button>
          </form>
        </div>
      </header>

      {!data.hasAccount ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No Sales Tax Payable account yet. It’s created automatically the first time you post an invoice that charges sales tax.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Opening liability" value={fmt(data.openingBalance)} hint={`before ${data.fromDate}`} />
            <SummaryCard label="Tax collected" value={fmt(data.collected)} hint="charged to customers" tone="emerald" />
            <SummaryCard label="Tax remitted" value={fmt(data.remitted)} hint="paid to authority" tone="blue" />
            <SummaryCard label="Ending liability" value={fmt(data.endingBalance)} hint="owed as of " toneStrong />
          </div>

          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Detail</th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Collected</th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Remitted</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-zinc-500">No sales-tax activity in this period.</td></tr>
                )}
                {data.lines.map((l) => (
                  <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">{fmtDate(l.date)}</td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{l.memo ?? '—'}</td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{l.contactName ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{l.collected > 0 ? fmt(l.collected) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400">{l.remitted > 0 ? fmt(l.remitted) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-zinc-50 dark:bg-zinc-900">
                <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
                  <td colSpan={3} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Period totals</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(data.collected)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(data.remitted)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {data.linesCapped && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Showing the most recent 500 lines — narrow the date range to see the rest.</p>
          )}
          <p className="text-xs text-zinc-400">
            Reads the {data.accountNames.join(', ')} account. Collected = tax charged on invoices; remitted = payments to the tax authority recorded against the liability.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, hint, tone, toneStrong }: { label: string; value: string; hint?: string; tone?: 'emerald' | 'blue'; toneStrong?: boolean }) {
  const valueTone = toneStrong
    ? 'text-zinc-900 dark:text-zinc-100'
    : tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'blue'
        ? 'text-blue-700 dark:text-blue-400'
        : 'text-zinc-900 dark:text-zinc-100';
  return (
    <div className={`rounded-lg border p-4 ${toneStrong ? 'border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-400">{hint}</div>}
    </div>
  );
}
