'use client';

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export interface TrendPoint {
  date: string;
  revenue: number;
  expenses: number;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        Not enough data to chart yet.
      </div>
    );
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="exp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" stroke="#71717a" fontSize={11} />
          <YAxis
            stroke="#71717a"
            fontSize={11}
            tickFormatter={(v) =>
              new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
            }
          />
          <Tooltip
            formatter={(v) => {
              const n = typeof v === 'number' ? v : Number(v);
              return Number.isFinite(n)
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
                : String(v);
            }}
            contentStyle={{ fontSize: 12 }}
          />
          <Area type="monotone" dataKey="revenue" stroke="#10b981" fill="url(#rev)" strokeWidth={2} />
          <Area type="monotone" dataKey="expenses" stroke="#ef4444" fill="url(#exp)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
