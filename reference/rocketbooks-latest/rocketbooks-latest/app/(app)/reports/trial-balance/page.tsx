import Link from 'next/link';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso } from '@/lib/reports/dates';
import { loadTrialBalance, loadAdjustedTrialBalance } from '@/lib/reports/trial-balance-data';
import { detectAsOfPreset, getAsOfPresets } from '@/lib/reports/date-presets';
import { AsOfPresetSelect } from '@/components/reports/AsOfPresetSelect';
import { resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { ExportPdfButton } from '@/components/reports/ExportPdfButton';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

interface PageProps {
  searchParams: Promise<{ asOf?: string; basis?: string; view?: string }>;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const amt = (n: number) => (n > 0 ? fmt(n) : '');

export default async function TrialBalancePage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { asOf, basis: basisParam, view } = await searchParams;
  const asOfDate = safeIsoDate(asOf, todayIso());
  const basis = await resolveBasis(orgId, basisParam);
  const adjusted = view === 'adjusted';

  const pdfDisabled = await hasActiveDemoTrial(orgId);
  const pdfHref = `/api/reports/trial-balance/pdf?asOf=${encodeURIComponent(asOfDate)}&basis=${basis}`;

  const backHref = `/reports/trial-balance?asOf=${encodeURIComponent(asOfDate)}&basis=${basis}${adjusted ? '&view=adjusted' : ''}`;
  const drillHref = (accountId: string) =>
    `/reports/account/${encodeURIComponent(accountId)}?from=1900-01-01&to=${encodeURIComponent(asOfDate)}` +
    `&back=${encodeURIComponent(backHref)}&backLabel=${encodeURIComponent('Trial balance')}`;

  // View toggle hrefs preserve date + basis.
  const viewHref = (v?: string) =>
    `/reports/trial-balance?asOf=${encodeURIComponent(asOfDate)}&basis=${basis}${v ? `&view=${v}` : ''}`;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Trial Balance</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">As of {asOfDate}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-zinc-300 text-sm dark:border-zinc-700">
            <Link
              href={viewHref()}
              className={`px-3 py-1 ${!adjusted ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}
            >
              Standard
            </Link>
            <Link
              href={viewHref('adjusted')}
              className={`px-3 py-1 ${adjusted ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}
            >
              Adjusted
            </Link>
          </div>
          <BasisToggle basis={basis} />
          <AsOfPresetSelect presets={getAsOfPresets()} currentKey={detectAsOfPreset(asOfDate)} />
          <form className="flex items-center gap-2">
            <label className="text-xs text-zinc-500">As of</label>
            <input
              type="date"
              name="asOf"
              defaultValue={asOfDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input type="hidden" name="basis" value={basis} />
            {adjusted && <input type="hidden" name="view" value="adjusted" />}
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Apply
            </button>
          </form>
          {!adjusted && <ExportPdfButton href={pdfHref} disabled={pdfDisabled} />}
        </div>
      </header>

      {adjusted ? (
        <AdjustedTable data={await loadAdjustedTrialBalance(orgId, asOfDate, basis)} drillHref={drillHref} />
      ) : (
        <StandardTable data={await loadTrialBalance(orgId, asOfDate, basis)} drillHref={drillHref} />
      )}
    </div>
  );
}

function StandardTable({
  data,
  drillHref,
}: {
  data: Awaited<ReturnType<typeof loadTrialBalance>>;
  drillHref: (id: string) => string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">#</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">GAAP</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Debit</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                No balances as of {data.asOfDate}.
              </td>
            </tr>
          )}
          {data.rows.map((b) => {
            const href = drillHref(b.accountId);
            return (
              <tr key={b.accountId} className="border-t border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                <td className="p-0 tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-4 py-2">{b.accountNumber}</Link></td>
                <td className="p-0 text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-4 py-2 hover:underline">{b.accountName}</Link></td>
                <td className="p-0 text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-4 py-2">{b.gaapType}</Link></td>
                <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-4 py-2">{amt(b.netDebit)}</Link></td>
                <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-4 py-2">{amt(b.netCredit)}</Link></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={3} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Totals · {data.balanced ? '✓ Balanced' : `Diff: ${fmt(Math.abs(data.totalDebit - data.totalCredit))}`}
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(data.totalDebit)}</td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(data.totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AdjustedTable({
  data,
  drillHref,
}: {
  data: Awaited<ReturnType<typeof loadAdjustedTrialBalance>>;
  drillHref: (id: string) => string;
}) {
  const t = data.totals;
  const HeadAmt = ({ children }: { children: React.ReactNode }) => (
    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">{children}</th>
  );
  const Cell = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-3 py-2">{children}</Link></td>
  );
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="text-left">
            <th className="px-3 py-1" />
            <th className="px-3 py-1" />
            <th className="px-3 py-1" />
            <th colSpan={2} className="border-l border-zinc-200 px-3 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800">Unadjusted</th>
            <th colSpan={2} className="border-l border-zinc-200 px-3 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:border-zinc-800 dark:text-amber-400">Adjustments</th>
            <th colSpan={2} className="border-l border-zinc-200 px-3 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800">Adjusted</th>
          </tr>
          <tr className="text-left">
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">#</th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">GAAP</th>
            <HeadAmt>Debit</HeadAmt><HeadAmt>Credit</HeadAmt>
            <HeadAmt>Debit</HeadAmt><HeadAmt>Credit</HeadAmt>
            <HeadAmt>Debit</HeadAmt><HeadAmt>Credit</HeadAmt>
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 && (
            <tr><td colSpan={9} className="px-4 py-6 text-center text-zinc-500">No balances as of {data.asOfDate}.</td></tr>
          )}
          {data.rows.map((b) => {
            const href = drillHref(b.accountId);
            const hasAdj = b.adjustmentDebit > 0 || b.adjustmentCredit > 0;
            return (
              <tr key={b.accountId} className={`border-t border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 ${hasAdj ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}>
                <td className="p-0 tabular-nums text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-3 py-2">{b.accountNumber}</Link></td>
                <td className="p-0 text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-3 py-2 hover:underline">{b.accountName}</Link></td>
                <td className="p-0 text-zinc-700 dark:text-zinc-300"><Link href={href} className="block px-3 py-2">{b.gaapType}</Link></td>
                <Cell href={href}>{amt(b.unadjustedDebit)}</Cell>
                <Cell href={href}>{amt(b.unadjustedCredit)}</Cell>
                <Cell href={href}>{amt(b.adjustmentDebit)}</Cell>
                <Cell href={href}>{amt(b.adjustmentCredit)}</Cell>
                <Cell href={href}>{amt(b.adjustedDebit)}</Cell>
                <Cell href={href}>{amt(b.adjustedCredit)}</Cell>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={3} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Totals · {data.balanced ? '✓ Balanced' : `Diff: ${fmt(Math.abs(t.adjustedDebit - t.adjustedCredit))}`}
            </td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.unadjustedDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.unadjustedCredit)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.adjustmentDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.adjustmentCredit)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.adjustedDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(t.adjustedCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
