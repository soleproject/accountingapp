'use client';

import { fmtCurrency } from '@/lib/personal/format';

interface Point { month: string; income: number; expense: number; net: number }

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

export function TrendsChart({ points }: { points: Point[] }) {
  if (points.length === 0) return null;

  const W = 820;
  const H = 220;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const yMax = Math.max(1, ...points.map((p) => Math.max(p.income, p.expense)));
  const n = points.length;
  const slotW = plotW / n;
  const barW = Math.min(14, slotW * 0.32);

  const yTop = (v: number) => padT + (1 - v / yMax) * plotH;
  const ticks = [yMax, yMax / 2, 0];

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full min-w-[640px]" role="img" aria-label="Monthly income vs expense">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={yTop(t)} x2={W - padR} y2={yTop(t)} className="stroke-zinc-100 dark:stroke-zinc-800" strokeWidth="1" />
            <text x={padL - 8} y={yTop(t) + 3} textAnchor="end" className="fill-zinc-400 text-[10px]">{fmtCurrency(t)}</text>
          </g>
        ))}

        {points.map((p, i) => {
          const slotX = padL + i * slotW;
          const incX = slotX + slotW / 2 - barW - 1;
          const expX = slotX + slotW / 2 + 1;
          const incH = (p.income / yMax) * plotH;
          const expH = (p.expense / yMax) * plotH;
          return (
            <g key={p.month}>
              <rect x={incX} y={yTop(p.income)} width={barW} height={incH} rx="1.5" className="fill-emerald-500">
                <title>{`${monthLabel(p.month)} income ${fmtCurrency(p.income)}`}</title>
              </rect>
              <rect x={expX} y={yTop(p.expense)} width={barW} height={expH} rx="1.5" className="fill-rose-500">
                <title>{`${monthLabel(p.month)} expense ${fmtCurrency(p.expense)} · net ${fmtCurrency(p.net)}`}</title>
              </rect>
              <text x={slotX + slotW / 2} y={H - 14} textAnchor="middle" className="fill-zinc-400 text-[9px]">{monthLabel(p.month)}</text>
              {(i === 0 || i === n - 1 || p.month.endsWith('-01')) && (
                <text x={slotX + slotW / 2} y={H - 4} textAnchor="middle" className="fill-zinc-300 text-[8px]">{p.month.slice(0, 4)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 px-2 text-xs text-zinc-500">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> Income</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-rose-500" /> Expense</span>
      </div>
    </div>
  );
}
