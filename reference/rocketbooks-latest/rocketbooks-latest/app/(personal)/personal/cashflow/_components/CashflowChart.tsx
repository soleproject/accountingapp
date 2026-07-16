'use client';

import { fmtCurrency } from '@/lib/personal/format';

interface Day {
  day: number;
  balance: number;
  projected: boolean;
}

export function CashflowChart({ days, today, monthLabel }: { days: Day[]; today: number; monthLabel: string }) {
  if (days.length < 2) return null;

  const W = 800;
  const H = 240;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const balances = days.map((d) => d.balance);
  let min = Math.min(...balances, 0);
  let max = Math.max(...balances, 0);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;

  const n = days.length;
  const x = (day: number) => padL + ((day - 1) / (n - 1)) * plotW;
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * plotH;

  const pts = days.map((d) => ({ x: x(d.day), y: y(d.balance), projected: d.projected, day: d.day }));
  const todayIdx = pts.findIndex((p) => p.day === today);
  const actual = pts.slice(0, todayIdx + 1);
  const projected = pts.slice(todayIdx); // includes today as the join point

  const line = (p: { x: number; y: number }[]) => p.map((q, i) => `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
  const areaPath = `${line(actual)} L${actual[actual.length - 1].x.toFixed(1)},${y(min).toFixed(1)} L${actual[0].x.toFixed(1)},${y(min).toFixed(1)} Z`;

  const zeroInRange = min < 0 && max > 0;
  const todayPt = pts[todayIdx];
  const endPt = pts[pts.length - 1];

  // A few y gridlines/labels.
  const ticks = [max - pad, (max + min) / 2, min + pad];

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full min-w-[600px]" role="img" aria-label={`Cash balance for ${monthLabel}`}>
        {/* y gridlines + labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} className="stroke-zinc-100 dark:stroke-zinc-800" strokeWidth="1" />
            <text x={padL - 8} y={y(t) + 3} textAnchor="end" className="fill-zinc-400 text-[10px]">{fmtCurrency(t)}</text>
          </g>
        ))}
        {/* zero baseline */}
        {zeroInRange && (
          <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} className="stroke-zinc-300 dark:stroke-zinc-700" strokeWidth="1" strokeDasharray="2 3" />
        )}

        {/* actual area + line */}
        <path d={areaPath} className="fill-sky-500/10" />
        <path d={line(actual)} className="stroke-sky-500" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {/* projected (dashed) */}
        <path d={line(projected)} className="stroke-sky-400/70" strokeWidth="2" fill="none" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" />

        {/* today marker */}
        <line x1={todayPt.x} y1={padT} x2={todayPt.x} y2={padT + plotH} className="stroke-zinc-300 dark:stroke-zinc-700" strokeWidth="1" />
        <circle cx={todayPt.x} cy={todayPt.y} r="3.5" className="fill-sky-500" />
        <circle cx={endPt.x} cy={endPt.y} r="3.5" className="fill-sky-400" />

        {/* x labels: day 1, today, last */}
        <text x={x(1)} y={H - 6} textAnchor="start" className="fill-zinc-400 text-[10px]">1</text>
        <text x={todayPt.x} y={H - 6} textAnchor="middle" className="fill-zinc-500 text-[10px]">today</text>
        <text x={x(n)} y={H - 6} textAnchor="end" className="fill-zinc-400 text-[10px]">{n}</text>
      </svg>
      <div className="mt-1 flex items-center gap-4 px-2 text-xs text-zinc-500">
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-sky-500" /> Actual</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-sky-400" /> Projected</span>
      </div>
    </div>
  );
}
