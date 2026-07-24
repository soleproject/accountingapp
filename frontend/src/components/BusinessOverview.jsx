import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import {
  Play, Wallet2, ArrowUpRight, ArrowDownRight, Building2, PiggyBank,
} from "lucide-react";

function monthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// --- inline SVG donut (shared shape with FirmAtAGlance) ---
function DonutChart({ slices, size = 156, thickness = 26 }) {
  const total = slices.reduce((s, x) => s + (x.amount || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
      {total > 0 && slices.map((s, i) => {
        const frac = (s.amount || 0) / total;
        const len = frac * circ;
        const dashOffset = -acc;
        acc += len;
        return (
          <circle
            key={i}
            cx={cx} cy={cy} r={r} fill="none"
            stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${len} ${circ - len}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
      })}
    </svg>
  );
}

// --- inline SVG line chart for the Sales card ---
function SalesLineChart({ points, w = 340, h = 130 }) {
  if (!points || points.length === 0) {
    return <div className="text-xs text-slate-400">No sales data.</div>;
  }
  const max = Math.max(1, ...points.map(p => p.amount || 0));
  const pad = 24;
  const stepX = (w - pad * 2) / Math.max(points.length - 1, 1);
  const y = v => h - pad - ((v / max) * (h - pad * 2));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${pad + i * stepX},${y(p.amount || 0)}`).join(" ");
  const areaPath = `${path} L${pad + (points.length - 1) * stepX},${h - pad} L${pad},${h - pad} Z`;
  // 3 y-gridlines: max, mid, 0
  const gridVals = [max, max / 2, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={pad} x2={w - pad} y1={y(v)} y2={y(v)} stroke="#e2e8f0" strokeDasharray="3 3" />
          <text x={4} y={y(v) + 3} fontSize="9" fill="#94a3b8">
            ${(v >= 1000 ? `${Math.round(v/1000)}K` : Math.round(v))}
          </text>
        </g>
      ))}
      <path d={areaPath} fill="#dcfce7" opacity="0.6" />
      <path d={path} fill="none" stroke="#22c55e" strokeWidth="2" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={pad + i * stepX} cy={y(p.amount || 0)} r={3} fill="#22c55e" />
          <text x={pad + i * stepX} y={h - 6} fontSize="9" fill="#94a3b8" textAnchor="middle">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// -------- Main component --------
export default function BusinessOverview() {
  const { currentId, current } = useCompany();
  const [month] = useState(() => monthKey(0));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api.get(`/companies/${currentId}/dashboard/business-overview`, { params: { month } })
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [currentId, month]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
  }, [month]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl md:text-4xl font-bold tracking-tight text-slate-900">
          Business overview
        </h1>
        <p className="text-slate-500 text-sm mt-1">{current?.name} · Last month view</p>
      </div>

      {/* Row 1: Invoices | Expenses | Bank accounts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Invoices */}
        <div className="rounded-xl border bg-white p-5" data-testid="bo-invoices">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Invoices</div>
          </div>
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">
            {fmtMoney(data?.invoices?.unpaid_365 ?? 0)} unpaid <span className="ml-1 text-slate-400 normal-case">last 365 days</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 mt-1">
            <div>
              <div className="font-mono-num text-xl font-bold text-slate-900">
                {fmtMoney(data?.invoices?.overdue ?? 0)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Overdue</div>
              <div className="mt-2 h-2 rounded-full bg-orange-100">
                <div
                  className="h-full rounded-full bg-orange-500"
                  style={{
                    width: `${pctBar(data?.invoices?.overdue, data?.invoices?.unpaid_365)}%`,
                  }}
                />
              </div>
            </div>
            <div>
              <div className="font-mono-num text-xl font-bold text-slate-900">
                {fmtMoney((data?.invoices?.unpaid_365 || 0) - (data?.invoices?.overdue || 0))}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Not due yet</div>
              <div className="mt-2 h-2 rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-400"
                  style={{
                    width: `${100 - pctBar(data?.invoices?.overdue, data?.invoices?.unpaid_365)}%`,
                  }}
                />
              </div>
            </div>
          </div>
          <div className="mt-4 text-[11px] text-slate-500 uppercase tracking-wider">
            {fmtMoney(data?.invoices?.paid_30 ?? 0)} paid <span className="ml-1 text-slate-400 normal-case">last 30 days</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 mt-1">
            <div>
              <div className="font-mono-num text-xl font-bold text-slate-900">
                {fmtMoney(data?.invoices?.not_deposited ?? 0)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Not deposited</div>
              <div className="mt-2 h-2 rounded-full bg-emerald-100">
                <div
                  className="h-full rounded-full bg-emerald-400"
                  style={{
                    width: `${pctBar(data?.invoices?.not_deposited, data?.invoices?.paid_30)}%`,
                  }}
                />
              </div>
            </div>
            <div>
              <div className="font-mono-num text-xl font-bold text-slate-900">
                {fmtMoney(data?.invoices?.deposited ?? 0)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Deposited</div>
              <div className="mt-2 h-2 rounded-full bg-emerald-100">
                <div
                  className="h-full rounded-full bg-emerald-600"
                  style={{
                    width: `${pctBar(data?.invoices?.deposited, data?.invoices?.paid_30)}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Expenses */}
        <div className="rounded-xl border bg-white p-5" data-testid="bo-expenses">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Expenses</div>
            <div className="text-[11px] text-slate-500">Last month</div>
          </div>
          <div className="font-mono-num text-3xl font-bold text-slate-900">
            {fmtMoney(data?.expenses?.total ?? 0)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">
            Last month
          </div>
          <div className="flex items-center gap-4">
            <DonutChart slices={data?.expenses?.categories || []} />
            <div className="flex-1 min-w-0 space-y-1.5">
              {(data?.expenses?.categories || []).slice(0, 5).map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                  <div className="min-w-0">
                    <div className="font-mono-num font-semibold text-slate-900">{fmtMoney(c.amount)}</div>
                    <div className="text-[10px] text-slate-500 truncate">{c.name}</div>
                  </div>
                </div>
              ))}
              {!loading && !(data?.expenses?.categories || []).length && (
                <div className="text-xs text-slate-500">No expenses last month.</div>
              )}
            </div>
          </div>
        </div>

        {/* Bank accounts */}
        <div className="rounded-xl border bg-white p-5" data-testid="bo-banks">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Bank accounts</div>
          </div>
          <div className="space-y-4">
            {["checking", "savings"].map(cat => {
              const rows = (data?.bank_accounts?.accounts || []).filter(a => a.category === cat);
              if (!rows.length) return null;
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-2">
                    {cat === "savings" ? (
                      <PiggyBank size={13} className="text-slate-500" />
                    ) : (
                      <Building2 size={13} className="text-slate-500" />
                    )}
                    <div className="text-xs font-semibold text-slate-800 capitalize">{cat}</div>
                  </div>
                  {rows.map(a => (
                    <div key={a.id} className="grid grid-cols-2 gap-x-4 py-1.5 border-b border-slate-100 last:border-b-0">
                      <div className="text-[11px] text-slate-500">
                        <div>Bank Balance</div>
                        <div>In QuickBooks</div>
                      </div>
                      <div className="text-right font-mono-num text-[13px]">
                        <div className="text-slate-900 font-semibold">{fmtMoney(a.bank_balance)}</div>
                        <div className={a.bank_balance !== a.in_books ? "text-orange-600" : "text-slate-500"}>
                          {fmtMoney(a.in_books)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            {!loading && !(data?.bank_accounts?.accounts || []).length && (
              <div className="text-xs text-slate-500">
                No bank accounts connected. <Link to="/connections" className="text-indigo-600 hover:underline">Connect →</Link>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between mt-4 pt-3 border-t">
            <Link to="/connections" className="text-[11px] text-indigo-600 hover:text-indigo-800">
              Connect accounts
            </Link>
            <Link to="/connections" className="text-[11px] text-slate-500 hover:text-slate-700">
              Go to registers &rarr;
            </Link>
          </div>
        </div>
      </div>

      {/* Row 2: Profit & Loss | Sales | Discover */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Profit & Loss */}
        <div className="rounded-xl border bg-white p-5" data-testid="bo-pl">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Profit and Loss</div>
            <div className="text-[11px] text-slate-500">Last month</div>
          </div>
          <div className="font-mono-num text-3xl font-bold text-slate-900">
            {fmtMoney(data?.profit_loss?.net_profit ?? 0)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">
            Net income for {monthLabel}
          </div>
          <div className="space-y-3">
            <PLBar
              label="Income"
              amount={data?.profit_loss?.income}
              max={Math.max(data?.profit_loss?.income || 1, data?.profit_loss?.expense || 1)}
              color="bg-emerald-500"
              arrow="up"
            />
            <PLBar
              label="Expenses"
              amount={data?.profit_loss?.expense}
              max={Math.max(data?.profit_loss?.income || 1, data?.profit_loss?.expense || 1)}
              color="bg-teal-500"
              arrow="down"
            />
          </div>
        </div>

        {/* Sales */}
        <div className="rounded-xl border bg-white p-5" data-testid="bo-sales">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Sales</div>
            <div className="text-[11px] text-slate-500">Last month</div>
          </div>
          <div className="font-mono-num text-3xl font-bold text-slate-900">
            {fmtMoney(data?.sales?.quarter_total ?? 0)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">
            This quarter
          </div>
          <SalesLineChart points={data?.sales?.months || []} />
        </div>

        {/* Discover */}
        <div className="rounded-xl border bg-white p-5 flex flex-col" data-testid="bo-discover">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-3">
            Discover
          </div>
          <div className="flex-1 flex items-center justify-center mb-4 rounded-lg bg-gradient-to-br from-slate-50 to-slate-100 py-6">
            <button
              className="w-14 h-14 rounded-full bg-white shadow-md border border-slate-200 flex items-center justify-center hover:shadow-lg transition"
              aria-label="Play video"
              data-testid="bo-discover-play"
            >
              <Play size={20} className="text-emerald-600 ml-0.5" fill="currentColor" />
            </button>
          </div>
          <div className="text-sm font-semibold text-slate-900 mb-1">
            Streamline your firm with AI Copilot
          </div>
          <div className="text-xs text-slate-500 mb-3">
            Learn how {current?.name || "your firm"} can automate categorization, close books faster,
            and cut month-end review time by 40% in a 90-second video.
          </div>
          <Link
            to="/accounting/ai-cleanup-review"
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            Try AI Cleanup Review &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}

// --- helpers ---
function pctBar(part, whole) {
  if (!whole) return 0;
  return Math.min(100, Math.max(0, ((part || 0) / whole) * 100));
}

function PLBar({ label, amount, max, color, arrow }) {
  const w = Math.min(100, Math.max(0, ((amount || 0) / (max || 1)) * 100));
  const Icon = arrow === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="font-mono-num font-semibold text-slate-900">{fmtMoney(amount ?? 0)}</div>
        <Icon size={16} className={arrow === "up" ? "text-emerald-600" : "text-teal-600"} />
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}
