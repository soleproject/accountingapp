import Link from 'next/link';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';
import { loadCashFlow, type CashFlowMode, type CashFlowSection } from '@/lib/reports/cash-flow-data';
import { detectPeriodPreset, getPeriodPresets } from '@/lib/reports/date-presets';
import { PeriodPresetSelect } from '@/components/reports/PeriodPresetSelect';
import { resolveBasis } from '@/lib/reports/basis-filter';
import { BasisToggle } from '@/components/reports/BasisToggle';
import { ExportPdfButton } from '@/components/reports/ExportPdfButton';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; mode?: string; basis?: string }>;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function CashFlowPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { from, to, mode: modeStr, basis: basisParam } = await searchParams;
  const fromDate = safeIsoDate(from, yearStartIso());
  const toDate = safeIsoDate(to, todayIso());
  const mode: CashFlowMode = modeStr === 'simple' ? 'simple' : 'real';
  const basis = await resolveBasis(orgId, basisParam);

  const data = await loadCashFlow(orgId, fromDate, toDate, mode, basis);

  // Drill links route through /reports/account/[id] with back/backLabel so
  // the breadcrumb chain returns here.
  const backHref = `/reports/cash-flow?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&mode=${mode}&basis=${basis}`;
  const drillHref = (accountId: string) =>
    `/reports/account/${encodeURIComponent(accountId)}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}` +
    `&back=${encodeURIComponent(backHref)}&backLabel=${encodeURIComponent('Cash flow')}`;

  const pdfHref = `/api/reports/cash-flow/pdf?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&mode=${mode}&basis=${basis}`;
  const pdfDisabled = await hasActiveDemoTrial(orgId);

  const buildHref = (overrides: { mode?: CashFlowMode }) => {
    const params = new URLSearchParams();
    params.set('from', fromDate);
    params.set('to', toDate);
    params.set('mode', overrides.mode ?? mode);
    return `/reports/cash-flow?${params.toString()}`;
  };

  if (data.cashAccountIds.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-2xl font-semibold">Cash Flow Statement</h1>
        </header>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-900/20">
          No cash accounts in this organization. Add a bank account (Plaid or
          manually in the Chart of Accounts with accountType=bank) to see cash
          flow.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Cash Flow Statement{mode === 'simple' ? ' (simple)' : ''}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {fromDate} → {toDate} ·{' '}
            {mode === 'real'
              ? 'Operating / investing / financing breakdown of cash movements'
              : 'Cash inflows minus outflows on cash accounts'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            {(['simple', 'real'] as const).map((m) => (
              <Link
                key={m}
                href={buildHref({ mode: m })}
                className={`rounded px-3 py-1 ${
                  mode === m
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                }`}
              >
                {m === 'simple' ? 'Simple' : 'Real (O/I/F)'}
              </Link>
            ))}
          </div>
          <BasisToggle basis={basis} />
          <PeriodPresetSelect
            presets={getPeriodPresets()}
            currentKey={detectPeriodPreset(fromDate, toDate)}
          />
          <form className="flex items-center gap-2">
            <input
              type="hidden"
              name="mode"
              value={mode}
            />
            <input
              type="hidden"
              name="basis"
              value={basis}
            />
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
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Apply
            </button>
          </form>
          <ExportPdfButton href={pdfHref} disabled={pdfDisabled} />
        </div>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <Tile label="Cash at start" value={data.beginningCash} tone="zinc" />
        <Tile
          label="Net change"
          value={data.totals.netChange}
          tone={data.totals.netChange >= 0 ? 'emerald' : 'red'}
        />
        <Tile label="Cash at end" value={data.endingCash} tone="zinc" />
      </div>

      {mode === 'real' && (
        <div className="grid grid-cols-3 gap-4 text-sm">
          <SubTile label="Operating" value={data.totals.operating} />
          <SubTile label="Investing" value={data.totals.investing} />
          <SubTile label="Financing" value={data.totals.financing} />
        </div>
      )}

      {data.sections.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No cash activity in this period.
        </div>
      ) : (
        data.sections.map((section) => (
          <Section key={section.id} section={section} drillHref={drillHref} mode={mode} />
        ))
      )}

      <p className="text-xs text-zinc-500">
        {mode === 'real'
          ? 'Real cash flow: every JE that touched a cash account, classified by the offsetting non-cash account. Operating = income / expense / working capital; Investing = fixed assets and other long-term assets; Financing = long-term debt and equity.'
          : 'Simple cash flow: raw debits and credits per cash account in the period. Use the Real toggle for the standard operating / investing / financing breakdown.'}
      </p>
    </div>
  );
}

function Section({
  section,
  drillHref,
  mode,
}: {
  section: CashFlowSection;
  drillHref: (accountId: string) => string;
  mode: CashFlowMode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          {section.title}
        </h2>
        <span className="text-xs text-zinc-500">{section.rows.length} accounts</span>
      </header>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Cash In</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Cash Out</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Net</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => {
            const href = r.accountId ? drillHref(r.accountId) : null;
            const cells = (
              <>
                <span className="font-medium">
                  {r.accountNumber ? `${r.accountNumber} · ` : ''}{r.accountName}
                </span>
              </>
            );
            return (
              <tr key={r.accountId ?? r.accountName} className="border-t border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                <td className="p-0 text-zinc-700 dark:text-zinc-300">
                  {href ? (
                    <Link href={href} className="block px-4 py-2 hover:underline">{cells}</Link>
                  ) : (
                    <span className="block px-4 py-2">{cells}</span>
                  )}
                </td>
                <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {href ? (
                    <Link href={href} className="block px-4 py-2">{r.inflow > 0 ? fmt(r.inflow) : ''}</Link>
                  ) : (
                    <span className="block px-4 py-2">{r.inflow > 0 ? fmt(r.inflow) : ''}</span>
                  )}
                </td>
                <td className="p-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {href ? (
                    <Link href={href} className="block px-4 py-2">{r.outflow > 0 ? fmt(r.outflow) : ''}</Link>
                  ) : (
                    <span className="block px-4 py-2">{r.outflow > 0 ? fmt(r.outflow) : ''}</span>
                  )}
                </td>
                <td className="p-0 text-right tabular-nums font-medium">
                  {href ? (
                    <Link href={href} className="block px-4 py-2">{fmt(r.net)}</Link>
                  ) : (
                    <span className="block px-4 py-2">{fmt(r.net)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              {mode === 'real' ? `Net cash from ${section.title.toLowerCase()}` : `Total ${section.title.toLowerCase()}`}
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(section.inflow)}</td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(section.outflow)}</td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(section.net)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'red' | 'zinc';
}) {
  const palette =
    tone === 'emerald'
      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'
      : tone === 'red'
        ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
        : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950';
  return (
    <div className={`rounded-lg border p-4 ${palette}`}>
      <div className="text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(value)}</div>
    </div>
  );
}

function SubTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{fmt(value)}</div>
    </div>
  );
}
