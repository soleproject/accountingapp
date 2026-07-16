import Link from 'next/link';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso } from '@/lib/reports/dates';
import { loadBalanceSheet } from '@/lib/reports/balance-sheet-data';
import type { BalanceSheetLine } from '@/lib/reports/balance-sheet-data';
import { detectAsOfPreset, getAsOfPresets } from '@/lib/reports/date-presets';
import { AsOfPresetSelect } from '@/components/reports/AsOfPresetSelect';
import { resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { ExportPdfButton } from '@/components/reports/ExportPdfButton';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

interface PageProps {
  searchParams: Promise<{ asOf?: string; basis?: string }>;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function BalanceSheetPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { asOf, basis: basisParam } = await searchParams;
  const asOfDate = safeIsoDate(asOf, todayIso());
  const basis = await resolveBasis(orgId, basisParam);

  const data = await loadBalanceSheet(orgId, asOfDate, basis);
  const assets = [...data.currentAssets, ...data.fixedAssets, ...data.otherAssets];
  const liabilities = [
    ...data.currentLiabilities,
    ...data.longTermLiabilities,
    ...data.otherLiabilities,
  ];

  const pdfHref = `/api/reports/balance-sheet/pdf?asOf=${encodeURIComponent(asOfDate)}&basis=${basis}`;
  const pdfDisabled = await hasActiveDemoTrial(orgId);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Balance Sheet</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">As of {asOfDate}</p>
        </div>
        <div className="flex items-center gap-3">
          <BasisToggle basis={basis} />
          <AsOfPresetSelect
            presets={getAsOfPresets()}
            currentKey={detectAsOfPreset(asOfDate)}
          />
          <form className="flex items-center gap-2">
            <label className="text-xs text-zinc-500">As of</label>
            <input
              type="date"
              name="asOf"
              defaultValue={asOfDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Apply
            </button>
          </form>
          <ExportPdfButton href={pdfHref} disabled={pdfDisabled} />
        </div>
      </header>

      <Section title="Assets" rows={assets} total={data.totals.totalAssets} asOfDate={asOfDate} />
      <Section title="Liabilities" rows={liabilities} total={data.totals.totalLiabilities} asOfDate={asOfDate} />
      <Section title="Equity" rows={data.equity} total={data.totals.equity} asOfDate={asOfDate} />

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Total Liabilities + Equity</span>
          <span className="tabular-nums font-medium">{fmt(data.totals.totalLiabilitiesAndEquity)}</span>
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          {data.balanced
            ? '✓ Balance sheet equation holds'
            : `Out of balance: ${fmt(data.totals.totalAssets - data.totals.totalLiabilitiesAndEquity)}`}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  rows,
  total,
  asOfDate,
}: {
  title: string;
  rows: BalanceSheetLine[];
  total: number;
  asOfDate: string;
}) {
  // BS drilldowns show inception-to-date activity through asOfDate so prior-
  // period balances aren't hidden by a YTD default. 1900-01-01 is a safe
  // sentinel — predates any real bookkeeping data. back / backLabel keep the
  // breadcrumb pointing to the BS even after a further drill into a single
  // transaction.
  const backHref = `/reports/balance-sheet?asOf=${encodeURIComponent(asOfDate)}`;
  const drillHref = (accountId: string) =>
    `/reports/account/${encodeURIComponent(accountId)}?from=1900-01-01&to=${encodeURIComponent(asOfDate)}` +
    `&back=${encodeURIComponent(backHref)}&backLabel=${encodeURIComponent('Balance sheet')}`;
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{title}</h2>
      </header>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-3 text-center text-zinc-500">
                No {title.toLowerCase()} on this date.
              </td>
            </tr>
          )}
          {rows.map((b) => {
            // Synthetic Current Year Earnings line from balance-sheet-data has
            // no real account id; render it without a drill link.
            const isSynthetic = b.accountId === '__current_year_earnings__';
            if (isSynthetic) {
              return (
                <tr key={b.accountId} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="w-20 px-4 py-2 tabular-nums text-zinc-500">{b.accountNumber}</td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{b.accountName}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmt(b.balance)}</td>
                </tr>
              );
            }
            return (
              <tr
                key={b.accountId}
                className="border-t border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <td className="w-20 p-0 tabular-nums text-zinc-500">
                  <Link href={drillHref(b.accountId)} className="block px-4 py-2">
                    {b.accountNumber}
                  </Link>
                </td>
                <td className="p-0 text-zinc-700 dark:text-zinc-300">
                  <Link href={drillHref(b.accountId)} className="block px-4 py-2 hover:underline">
                    {b.accountName}
                  </Link>
                </td>
                <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  <Link href={drillHref(b.accountId)} className="block px-4 py-2">
                    {fmt(b.balance)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td colSpan={2} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Total {title}
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
