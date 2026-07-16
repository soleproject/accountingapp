import { fmtCurrency } from './format';
import { ExplainButton } from './ExplainButton';

interface Props {
  windowDays: number;
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netPL: number;
    totalAr: number;
    totalAp: number;
    cashNow: number;
    projectedCashAtForwardEnd: number;
  };
}

export function KpiTiles({ kpis, windowDays }: Props) {
  const tiles: Array<{
    label: string;
    value: number;
    tone: Tone;
    sub?: string;
  }> = [
    { label: `Revenue · ${windowDays}d`, value: kpis.totalRevenue, tone: 'emerald' },
    { label: `Expenses · ${windowDays}d`, value: kpis.totalExpenses, tone: 'rose' },
    {
      label: `Net P&L · ${windowDays}d`,
      value: kpis.netPL,
      tone: kpis.netPL >= 0 ? 'emerald' : 'rose',
    },
    { label: 'Cash on hand', value: kpis.cashNow, tone: 'sky' },
    {
      label: `Projected cash · +${windowDays}d`,
      value: kpis.projectedCashAtForwardEnd,
      tone: kpis.projectedCashAtForwardEnd >= kpis.cashNow ? 'emerald' : 'amber',
      sub:
        kpis.projectedCashAtForwardEnd - kpis.cashNow >= 0
          ? `+${fmtCurrency(kpis.projectedCashAtForwardEnd - kpis.cashNow)} vs today`
          : `${fmtCurrency(kpis.projectedCashAtForwardEnd - kpis.cashNow)} vs today`,
    },
    { label: 'Outstanding A/R', value: kpis.totalAr, tone: 'sky' },
    { label: 'Outstanding A/P', value: kpis.totalAp, tone: 'amber' },
  ];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">At a glance</h2>
        <ExplainButton
          prompt={`Walk me through these headline numbers on the Pulse page (revenue, expenses, net P&L, cash on hand, projected cash, A/R, A/P) for the last ${windowDays} days. Use the values in your page context. Briefly call out what stands out — anything unusual or noteworthy.`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
        {tiles.map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} tone={t.tone} sub={t.sub} />
        ))}
      </div>
    </section>
  );
}

type Tone = 'emerald' | 'rose' | 'sky' | 'amber';

const PALETTE: Record<Tone, string> = {
  emerald: 'border-emerald-200 dark:border-emerald-900',
  rose: 'border-rose-200 dark:border-rose-900',
  sky: 'border-sky-200 dark:border-sky-900',
  amber: 'border-amber-200 dark:border-amber-900',
};

function Tile({ label, value, tone, sub }: { label: string; value: number; tone: Tone; sub?: string }) {
  return (
    <div className={`rounded-lg border bg-white p-3 dark:bg-zinc-950 ${PALETTE[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{fmtCurrency(value)}</div>
      {sub && <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}
