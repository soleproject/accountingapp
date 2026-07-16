'use client';

import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';

export interface CashPoint {
  date: string;
  base: number;
  best: number;
  worst: number;
  range: [number, number];
}

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export function CashForecastChart({ data }: { data: CashPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-zinc-500">
        Connect a bank account to project cash.
      </div>
    );
  }
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="cashband" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.22} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" stroke="#71717a" fontSize={11} />
          <YAxis
            stroke="#71717a"
            fontSize={11}
            tickFormatter={(v) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}
          />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(value, name) => {
              if (name === 'Best / worst' && Array.isArray(value)) {
                const [lo, hi] = value as [number, number];
                return [`${usd(lo)} – ${usd(hi)}`, 'Best / worst'];
              }
              const n = typeof value === 'number' ? value : Number(value);
              return [Number.isFinite(n) ? usd(n) : String(value), name];
            }}
          />
          {/* Zero line marks where cash would run out. */}
          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4" />
          <Area type="monotone" dataKey="range" name="Best / worst" stroke="none" fill="url(#cashband)" />
          <Line type="monotone" dataKey="base" name="Projected" stroke="#3b82f6" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
