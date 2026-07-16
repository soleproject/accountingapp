import Link from 'next/link';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import { loadIncomeStatement } from '@/lib/reports/income-statement-data';
import type { IncomeStatementLine } from '@/lib/reports/income-statement-pdf';
import { detectPeriodPreset, getPeriodPresets } from '@/lib/reports/date-presets';
import { PeriodPresetSelect } from '@/components/reports/PeriodPresetSelect';
import { resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { ExportPdfButton } from '@/components/reports/ExportPdfButton';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; basis?: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function IncomeStatementPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { from, to, basis: basisParam } = await searchParams;
  const fromDate = safeIsoDate(from, yearStartIso());
  const toDate = safeIsoDate(to, todayIso());
  const basis = await resolveBasis(orgId, basisParam);

  const data = await loadIncomeStatement(orgId, fromDate, toDate, basis);
  const totalRevenue = data.totals.revenue + data.totals.otherIncome;
  const totalExpenses =
    data.totals.cogs + data.totals.operatingExpenses + data.totals.otherExpenses;
  const netIncome = data.totals.netIncome;
  const allRevenue = [...data.revenue, ...data.otherIncome];
  const allExpenses = [...data.cogs, ...data.operatingExpenses, ...data.otherExpenses];

  const pdfHref = `/api/reports/income-statement/pdf?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&basis=${basis}`;
  const pdfDisabled = await hasActiveDemoTrial(orgId);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Income Statement</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {fromDate} → {toDate}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <BasisToggle basis={basis} />
          <PeriodPresetSelect
            presets={getPeriodPresets()}
            currentKey={detectPeriodPreset(fromDate, toDate)}
          />
          <form className="flex items-center gap-2">
            <input
              type="date"
              name="from"
              defaultValue={fromDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="text-xs text-zinc-500">to</span>
            <input
              type="date"
              name="to"
              defaultValue={toDate}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Apply
            </button>
          </form>
          <ExportPdfButton href={pdfHref} disabled={pdfDisabled} />
        </div>
      </header>

      <Section title="Revenue" rows={allRevenue} total={totalRevenue} fromDate={fromDate} toDate={toDate} />
      <Section title="Expenses" rows={allExpenses} total={totalExpenses} fromDate={fromDate} toDate={toDate} />

      <div className={`rounded-lg border p-4 ${netIncome >= 0 ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20' : 'border-red-500 bg-red-50 dark:border-red-700 dark:bg-red-900/20'}`}>
        <div className="flex items-center justify-between text-base">
          <span className="font-medium">Net Income</span>
          <span className="tabular-nums font-semibold">{fmt(netIncome)}</span>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  rows,
  total,
  fromDate,
  toDate,
}: {
  title: string;
  rows: IncomeStatementLine[];
  total: number;
  fromDate: string;
  toDate: string;
}) {
  // back / backLabel keep the breadcrumb pointing to the IS even after a
  // further drill into a single transaction.
  const backHref = `/reports/income-statement?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`;
  const drillHref = (accountId: string) =>
    `/reports/account/${encodeURIComponent(accountId)}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}` +
    `&back=${encodeURIComponent(backHref)}&backLabel=${encodeURIComponent('Income statement')}`;
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
                No {title.toLowerCase()} in this period.
              </td>
            </tr>
          )}
          {rows.map((b) => (
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
          ))}
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
