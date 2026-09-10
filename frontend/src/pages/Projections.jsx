/**
 * Projections — cash-flow forecast page.
 *
 * Answers the client's core question: "Where will I be in 30/60/90/120
 * days?" Powered by `GET /api/companies/{cid}/projections/cashflow`
 * (blends open AR/AP, loans, payroll cadence, sales-tax remittance,
 * historical burn, and user-added recurring cash flows).
 *
 * v1 scope (locked): number bar + area chart + AI insights + editable
 * AR haircuts + recurring cashflows table (auto + user-added).
 * Scenario what-ifs come later (button placeholder at bottom links to
 * a future /accounting/projections/scenarios sub-page).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  Loader2, RefreshCw, Gauge, TrendingUp, TrendingDown, Sparkles,
  AlertTriangle, PlusCircle, Trash2, Info, ArrowRight, Settings2,
  CalendarClock, DollarSign, Radar, Check, X, Layers, Wallet,
} from "lucide-react";

const HAIRCUT_LABELS = {
  d0_30:   "0–30 days overdue",
  d30_60:  "30–60 days overdue",
  d60_90:  "60–90 days overdue",
  d90_plus: "90+ days overdue",
};

const CADENCE_OPTIONS = [
  { value: "one_time",   label: "One-time" },
  { value: "weekly",     label: "Weekly" },
  { value: "biweekly",   label: "Bi-weekly" },
  { value: "monthly",    label: "Monthly" },
  { value: "quarterly",  label: "Quarterly" },
];

export default function Projections() {
  const { currentId, current } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [recurring, setRecurring] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addRecOpen, setAddRecOpen] = useState(false);
  const [zoomDays, setZoomDays] = useState(null);
  const [detectionsOpen, setDetectionsOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  // "total" = combined cash across all bank accounts.
  // "per_account" = small-multiples, one chart per account.
  const [chartMode, setChartMode] = useState("total");

  const load = useCallback(async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      const [f, r] = await Promise.all([
        api.get(`/companies/${currentId}/projections/cashflow`, { params: { days: 120 } }),
        api.get(`/companies/${currentId}/projections/recurring`),
      ]);
      setData(f.data);
      setRecurring(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load projections.");
    } finally {
      setBusy(false);
    }
  }, [currentId]);

  useEffect(() => { load(); }, [load]);

  if (!currentId) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center" data-testid="projections-empty">
        <Gauge size={40} className="text-slate-300 mx-auto mb-3" />
        <div className="font-semibold text-slate-800">Pick a company first</div>
      </div>
    );
  }

  if (busy && !data) {
    return (
      <div className="p-12 flex items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5" data-testid="projections-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Accounting · Projections
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Where {current?.name || "you"} will be
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            120-day cash forecast blending open AR/AP, loans, payroll cadence,
            sales-tax obligations, and detected recurring cashflows. As of {data.as_of}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReviewDetectionsChip
            summary={data.pattern_summary}
            onClick={() => setDetectionsOpen(true)}
          />
          <button
            onClick={async () => {
              setRescanning(true);
              try {
                const r = await api.post(`/companies/${currentId}/projections/detect-patterns`);
                toast.success(`Scanned ${r.data.scanned_txns} txns · detected ${r.data.detected} patterns.`);
                await load();
              } catch (e) {
                toast.error(e?.response?.data?.detail || "Re-scan failed.");
              } finally {
                setRescanning(false);
              }
            }}
            disabled={rescanning}
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
            data-testid="projections-rescan-btn"
            title="Re-scan the last 365 days of transactions for recurring patterns"
          >
            <Radar size={13} className={rescanning ? "animate-spin" : ""} /> Re-scan
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5"
            data-testid="projections-settings-btn"
          >
            <Settings2 size={13} /> Assumptions
          </button>
          <button
            onClick={load}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
            data-testid="projections-refresh-btn"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Number bar */}
      <NumberBar data={data} fmtMoney={fmtMoney} zoomDays={zoomDays} onZoom={setZoomDays} />

      {/* Chart */}
      <ChartCard
        data={data}
        fmtMoney={fmtMoney}
        zoomDays={zoomDays}
        onZoom={setZoomDays}
        chartMode={chartMode}
        onChartMode={setChartMode}
      />

      {/* 2-col — insights + recurring */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <InsightsPanel insights={data.insights || []} />
        </div>
        <div className="lg:col-span-2">
          <RecurringPanel
            recurring={recurring}
            onAdd={() => setAddRecOpen(true)}
            onDelete={async (rid) => {
              try {
                await api.delete(`/companies/${currentId}/projections/recurring/${rid}`);
                toast.success("Removed.");
                await load();
              } catch (e) {
                toast.error(e?.response?.data?.detail || "Failed to remove.");
              }
            }}
          />
        </div>
      </div>

      {/* Scenarios button (v2 placeholder) */}
      <div className="rounded-xl border bg-white p-3 flex items-center justify-between flex-wrap gap-2" data-testid="projections-scenarios-cta">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-cyan-600" />
          <div>
            <div className="text-sm font-medium text-slate-900">What-if scenarios</div>
            <div className="text-xs text-slate-500">
              Model "what if I lose customer X", "what if I hire", "what if AR slips 30 days" — coming next.
            </div>
          </div>
        </div>
        <Link
          to="/accounting/projections/scenarios"
          className="text-xs px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 text-slate-400 pointer-events-none opacity-60"
          data-testid="projections-scenarios-open"
          title="Coming soon"
        >
          Open Scenarios <ArrowRight size={11} />
        </Link>
      </div>

      {settingsOpen && (
        <AssumptionsModal
          companyId={currentId}
          initial={data.settings_summary}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => { setSettingsOpen(false); await load(); }}
        />
      )}
      {addRecOpen && (
        <AddRecurringModal
          companyId={currentId}
          onClose={() => setAddRecOpen(false)}
          onSaved={async () => { setAddRecOpen(false); await load(); }}
        />
      )}
      {detectionsOpen && (
        <DetectionsModal
          companyId={currentId}
          onClose={() => setDetectionsOpen(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}


// -------- Sub-components ----------------------------------------------------

function NumberBar({ data, fmtMoney, zoomDays, onZoom }) {
  const cards = [
    { label: "Today", days: 0, cash: data.cash_today, delta: 0 },
    ...(data.snapshots || []).map(s => ({ label: `+${s.days} days`, ...s })),
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3" data-testid="projections-number-bar">
      {cards.map((c, i) => {
        const isFuture = c.days > 0;
        const isActive = zoomDays === c.days;
        const tone = !isFuture ? "slate"
          : c.cash < 0 ? "red"
          : c.delta < 0 ? "amber"
          : "emerald";
        const bg = {
          slate:   "border-slate-200 bg-white",
          red:     "border-red-200 bg-red-50/60",
          amber:   "border-amber-200 bg-amber-50/60",
          emerald: "border-emerald-200 bg-emerald-50/60",
        }[tone];
        const activeRing = isActive ? " ring-2 ring-slate-900 ring-offset-1" : "";
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              if (!isFuture) { onZoom(null); return; }
              onZoom(isActive ? null : c.days);
            }}
            className={`text-left rounded-xl border p-4 transition hover:shadow-md ${bg}${activeRing}`}
            data-testid={`projections-snap-${c.days}`}
            title={isFuture ? `Zoom chart to ${c.days} days` : "Show full 120-day view"}
          >
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              {c.label}
            </div>
            <div className="text-2xl font-bold text-slate-900 font-mono-num mt-1">
              {fmtMoney(c.cash)}
            </div>
            {isFuture && (
              <div className={`text-[11px] mt-1 flex items-center gap-1 ${
                c.delta > 0 ? "text-emerald-700" : c.delta < 0 ? "text-red-700" : "text-slate-500"
              }`}>
                {c.delta > 0 ? <TrendingUp size={11} /> : c.delta < 0 ? <TrendingDown size={11} /> : null}
                {c.delta === 0 ? "flat" : `${c.delta > 0 ? "+" : ""}${fmtMoney(c.delta)}`}
                {c.date && <span className="text-slate-400"> · {c.date}</span>}
              </div>
            )}
          </button>
        );
      })}
      <RunwayCard data={data} fmtMoney={fmtMoney} />
    </div>
  );
}

function RunwayCard({ data, fmtMoney }) {
  const days = data.runway_days;
  // Runway may exceed the horizon — treat 200+ days as "safe" but still
  // show the number so the CPA knows the forecast has visibility.
  const infinite = days == null;
  const label = infinite ? "∞" : `${Math.round(days)}d`;
  const months = infinite ? null : (days / 30).toFixed(1);
  const monthly = Math.abs(data.forward_monthly_burn || 0);
  const daily = Math.abs(data.forward_daily_burn || 0);
  const tone = infinite ? "emerald"
    : days < 60 ? "red"
    : days < 120 ? "amber"
    : "emerald";
  const bg = {
    red:     "border-red-200 bg-red-50/60",
    amber:   "border-amber-200 bg-amber-50/60",
    emerald: "border-emerald-200 bg-emerald-50/60",
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${bg}`} data-testid="projections-runway-card">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-1">
        <Gauge size={11} /> Runway
      </div>
      <div className="text-2xl font-bold text-slate-900 font-mono-num mt-1">{label}</div>
      <div className="text-[11px] text-slate-500 mt-1">
        {infinite ? (
          <>Cash trend flat/positive · no runway problem</>
        ) : (
          <>~{months} mo · burn {fmtMoney(monthly)}/mo · {fmtMoney(daily)}/day</>
        )}
      </div>
    </div>
  );
}


function ChartCard({ data, fmtMoney, zoomDays, onZoom, chartMode, onChartMode }) {
  const chartData = useMemo(() => {
    const rows = (data.timeline || []).map(row => ({ date: row.date, cash: row.cash }));
    if (zoomDays && rows.length) return rows.slice(0, zoomDays);
    return rows;
  }, [data.timeline, zoomDays]);
  const markers = useMemo(() => {
    const evs = (data.events || []).slice();
    const cutoff = zoomDays && chartData.length ? chartData[chartData.length - 1].date : null;
    const filtered = cutoff ? evs.filter(e => e.date <= cutoff) : evs;
    filtered.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return filtered.slice(0, 6);
  }, [data.events, zoomDays, chartData]);

  return (
    <div className="rounded-xl border bg-white p-4" data-testid="projections-chart-card">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Cash forecast · next {zoomDays || data.horizon_days} days
          </div>
          <div className="text-sm text-slate-600">
            {chartData.length ? `${chartData[0].date} → ${chartData[chartData.length - 1].date}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Total vs Per-account view */}
          <div className="flex items-center gap-1 border rounded-md p-0.5 bg-slate-50" data-testid="projections-chart-mode">
            <button
              onClick={() => onChartMode("total")}
              className={`text-[11px] px-2 py-1 rounded transition ${
                chartMode === "total"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
              data-testid="projections-chart-mode-total"
            >
              <Layers size={11} className="inline mr-1" />
              Total
            </button>
            <button
              onClick={() => onChartMode("per_account")}
              className={`text-[11px] px-2 py-1 rounded transition ${
                chartMode === "per_account"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
              data-testid="projections-chart-mode-per-account"
              disabled={!data.timeline_per_account || Object.keys(data.timeline_per_account || {}).length === 0}
            >
              <Wallet size={11} className="inline mr-1" />
              Per account
            </button>
          </div>
          {/* Horizon toggle */}
          <div className="flex items-center gap-1" data-testid="projections-horizon-toggle">
            {[30, 60, 90, 120].map(n => (
              <button
                key={n}
                onClick={() => onZoom(zoomDays === n ? null : n)}
                className={`text-[11px] px-2 py-1 rounded border transition ${
                  zoomDays === n
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 hover:bg-slate-100 border-slate-300"
                }`}
                data-testid={`projections-horizon-${n}`}
              >
                {n}d
              </button>
            ))}
            <button
              onClick={() => onZoom(null)}
              className={`text-[11px] px-2 py-1 rounded border transition ${
                !zoomDays
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 hover:bg-slate-100 border-slate-300"
              }`}
              data-testid="projections-horizon-all"
            >
              All
            </button>
          </div>
        </div>
      </div>

      {chartMode === "total" ? (
        <TotalChart chartData={chartData} fmtMoney={fmtMoney} />
      ) : (
        <PerAccountCharts
          data={data}
          zoomDays={zoomDays}
          fmtMoney={fmtMoney}
        />
      )}

      {markers.length > 0 && chartMode === "total" && (
        <div className="mt-3 border-t pt-2">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1">
            Biggest events on the horizon
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-[11px]" data-testid="projections-event-markers">
            {markers.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  <CalendarClock size={10} className="inline mr-1 text-slate-400" />
                  <b className="font-mono-num text-slate-500">{e.date}</b> · {e.label}
                  {e.kind === "pattern" && (
                    <span className="ml-1 text-[9px] uppercase text-cyan-700 bg-cyan-50 px-1 py-0.5 rounded" title={`Auto-detected · ${e.confidence} confidence`}>
                      detected
                    </span>
                  )}
                </span>
                <span className={`font-mono-num ${e.amount < 0 ? "text-red-700" : "text-emerald-700"}`}>
                  {e.amount < 0 ? "-" : "+"}${Math.abs(e.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}


function TotalChart({ chartData, fmtMoney }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="cashArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
            domain={[dataMin => Math.min(dataMin, 0), "auto"]}
          />
          <Tooltip
            formatter={(v) => fmtMoney(v)}
            labelFormatter={(l) => `On ${l}`}
            contentStyle={{ borderRadius: 6, fontSize: 12 }}
          />
          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
          <Area type="monotone" dataKey="cash" stroke="#0891b2" fill="url(#cashArea)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}


function PerAccountCharts({ data, zoomDays, fmtMoney }) {
  const accts = data.cash_breakdown || [];
  const perAcct = data.timeline_per_account || {};
  const palette = ["#0891b2", "#16a34a", "#f97316", "#a855f7", "#ec4899", "#eab308"];
  if (!accts.length) {
    return <div className="text-xs text-slate-500 py-8 text-center">No cash accounts to plot.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="projections-per-account-grid">
      {accts.map((a, idx) => {
        const rows = (perAcct[a.id] || []).map(r => ({ date: r.date, cash: r.cash }));
        const data = zoomDays && rows.length ? rows.slice(0, zoomDays) : rows;
        const stroke = palette[idx % palette.length];
        const endBal = data.length ? data[data.length - 1].cash : (a.balance || 0);
        return (
          <div key={a.id} className="border rounded-lg p-3 bg-white" data-testid={`projections-per-account-${a.id}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <div className="text-[11px] font-semibold text-slate-900 truncate">
                  {a.code ? <span className="text-slate-400 font-mono-num mr-1">{a.code}</span> : null}
                  {a.name}
                </div>
                <div className="text-[10px] text-slate-500">Today {fmtMoney(a.balance || 0)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-slate-400">End</div>
                <div className={`text-sm font-mono-num tabular-nums ${endBal < 0 ? "text-red-700" : "text-slate-900"}`}>
                  {fmtMoney(endBal)}
                </div>
              </div>
            </div>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={`gradient-${a.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stroke} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={stroke} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={60} />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                    domain={[dataMin => Math.min(dataMin, 0), "auto"]}
                    width={28}
                  />
                  <Tooltip
                    formatter={(v) => fmtMoney(v)}
                    labelFormatter={(l) => `${l}`}
                    contentStyle={{ borderRadius: 6, fontSize: 11 }}
                  />
                  <ReferenceLine y={0} stroke="#fca5a5" strokeDasharray="3 3" strokeWidth={0.8} />
                  <Area type="monotone" dataKey="cash" stroke={stroke} fill={`url(#gradient-${a.id})`} strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}


function ReviewDetectionsChip({ summary, onClick }) {
  const total = summary?.total || 0;
  if (!total) {
    return (
      <button
        onClick={onClick}
        className="text-xs px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5 text-slate-500"
        data-testid="projections-review-chip"
        title="No recurring patterns detected yet. Re-scan to run detection."
      >
        <Radar size={13} /> No patterns yet
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="text-xs px-2.5 py-1.5 rounded-md border border-cyan-300 bg-cyan-50 hover:bg-cyan-100 inline-flex items-center gap-1.5 text-cyan-800"
      data-testid="projections-review-chip"
      title="Review the recurring patterns Axiom detected in your history"
    >
      <Radar size={13} />
      Review detections
      <span className="ml-1 rounded bg-cyan-700 text-white px-1.5 text-[10px] font-semibold" data-testid="projections-review-chip-count">
        {total}
      </span>
      {summary?.high > 0 && (
        <span className="text-[10px] text-emerald-700">· {summary.high} high</span>
      )}
    </button>
  );
}


function DetectionsModal({ companyId, onClose, onChanged }) {
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState("active");

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/companies/${companyId}/projections/patterns`, {
        params: { status: tab },
      });
      setRows(r.data.patterns || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load patterns.");
    }
  }, [companyId, tab]);

  useEffect(() => { load(); }, [load]);

  const override = async (pk, patch) => {
    try {
      await api.post(`/companies/${companyId}/projections/patterns/${encodeURIComponent(pk)}/override`, patch);
      toast.success("Updated.");
      await load();
      onChanged && onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed.");
    }
  };

  const confBadge = (c) => {
    const s = { high: "bg-emerald-50 text-emerald-800 border-emerald-200",
                medium: "bg-amber-50 text-amber-800 border-amber-200",
                low: "bg-slate-50 text-slate-600 border-slate-200" }[c] || "";
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${s}`}>
        {c}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="projections-detections-modal"
      >
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold text-lg">Detected recurring cashflows</h3>
            <p className="text-xs text-slate-500 mt-1">
              Axiom scanned the last 365 days of transactions and grouped them by contact,
              amount, and cadence. Patterns are auto-applied to your forecast — reject the
              ones that shouldn't count.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900" data-testid="projections-detections-close">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-2 border-b flex items-center gap-2">
          {[
            { v: "active",   label: "Active" },
            { v: "rejected", label: "Rejected" },
          ].map(t => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              className={`text-xs px-2.5 py-1 rounded border ${
                tab === t.v ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 hover:bg-slate-100 border-slate-300"
              }`}
              data-testid={`projections-detections-tab-${t.v}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {rows === null ? (
            <div className="p-8 text-center text-slate-400"><Loader2 size={16} className="inline animate-spin" /></div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              {tab === "active" ? "No active patterns yet — hit Re-scan on the main page to detect from history." : "No rejected patterns."}
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map(p => (
                <li key={p.pattern_key} className="px-5 py-3 flex items-center gap-3" data-testid={`projections-detection-${p.pattern_key}`}>
                  <div className={`w-1.5 h-8 rounded-full ${p.median_amount >= 0 ? "bg-emerald-400" : "bg-red-400"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900 truncate">{p.label}</span>
                      {confBadge(p.confidence)}
                      <span className="text-[10px] text-slate-500">{p.cadence}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center gap-x-2 gap-y-0.5 flex-wrap mt-0.5">
                      <span>{p.occurrence_count} hits</span>
                      <span className="text-slate-300">·</span>
                      <span>every ~{Math.round(p.median_interval_days)}d</span>
                      <span className="text-slate-300">·</span>
                      <span>last {p.last_seen_date}</span>
                      <span className="text-slate-300">·</span>
                      <span>next {p.next_expected_date}</span>
                    </div>
                  </div>
                  <div className={`text-right font-mono-num tabular-nums font-semibold ${p.median_amount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                    {p.median_amount >= 0 ? "+" : "-"}{fmtMoney(Math.abs(p.median_amount))}
                  </div>
                  {tab === "active" ? (
                    <button
                      onClick={() => override(p.pattern_key, { status: "rejected" })}
                      className="text-slate-400 hover:text-red-600 shrink-0"
                      title="Exclude from forecast"
                      data-testid={`projections-detection-reject-${p.pattern_key}`}
                    >
                      <X size={16} />
                    </button>
                  ) : (
                    <button
                      onClick={() => override(p.pattern_key, { status: "active" })}
                      className="text-slate-400 hover:text-emerald-600 shrink-0"
                      title="Re-enable in forecast"
                      data-testid={`projections-detection-restore-${p.pattern_key}`}
                    >
                      <Check size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}


function InsightsPanel({ insights }) {
  return (
    <div className="rounded-xl border bg-white p-4 h-full" data-testid="projections-insights">
      <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-2 flex items-center gap-1.5">
        <Sparkles size={11} /> AI Insights
      </div>
      {insights.length === 0 ? (
        <div className="text-xs text-slate-500 py-8 text-center">
          No red flags in the next 120 days. Nice.
        </div>
      ) : (
        <ul className="space-y-2">
          {insights.map((n, i) => {
            const tone = {
              critical: "border-red-300 bg-red-50 text-red-900",
              warning:  "border-amber-300 bg-amber-50 text-amber-900",
              info:     "border-slate-200 bg-slate-50 text-slate-700",
            }[n.severity] || "border-slate-200 bg-slate-50 text-slate-700";
            const Icon = n.severity === "critical" || n.severity === "warning" ? AlertTriangle : Info;
            return (
              <li
                key={i}
                className={`rounded-lg border px-3 py-2 text-xs flex items-start gap-2 ${tone}`}
                data-testid={`projections-insight-${i}`}
              >
                <Icon size={13} className="shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div>{n.message}</div>
                  {n.date && <div className="text-[10px] opacity-70 mt-0.5">{n.date}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}


function RecurringPanel({ recurring, onAdd, onDelete }) {
  const auto = recurring?.auto || [];
  const custom = recurring?.custom || [];
  return (
    <div className="rounded-xl border bg-white p-4" data-testid="projections-recurring">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Recurring cashflows
          </div>
          <div className="text-sm text-slate-600">
            Auto-detected patterns + anything you've added.
          </div>
        </div>
        <button
          onClick={onAdd}
          className="text-xs px-2.5 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1.5"
          data-testid="projections-add-recurring-btn"
        >
          <PlusCircle size={13} /> Add recurring
        </button>
      </div>

      {custom.length === 0 && auto.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">
          None detected yet. Add expected inflows/outflows so the forecast improves.
        </div>
      ) : (
        <div className="space-y-3">
          {custom.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Yours
              </div>
              <ul className="divide-y">
                {custom.map(r => (
                  <li key={r.id} className="py-1.5 flex items-center gap-3 text-sm" data-testid={`projections-recurring-custom-${r.id}`}>
                    <DollarSign size={12} className={r.amount >= 0 ? "text-emerald-600" : "text-red-600"} />
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-900 font-medium truncate">{r.label}</div>
                      <div className="text-[11px] text-slate-500">
                        {r.cadence} · next {r.next_date}
                      </div>
                    </div>
                    <div className={`font-mono-num ${r.amount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {r.amount >= 0 ? "+" : "-"}${Math.abs(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <button
                      onClick={() => onDelete(r.id)}
                      className="text-slate-400 hover:text-red-600"
                      data-testid={`projections-recurring-delete-${r.id}`}
                      title="Remove"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {auto.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Auto-detected
              </div>
              <ul className="divide-y">
                {auto.slice(0, 6).map(r => (
                  <li key={r.id} className="py-1.5 flex items-center gap-3 text-sm" data-testid={`projections-recurring-auto-${r.id}`}>
                    <Sparkles size={12} className="text-cyan-500" />
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-900 font-medium truncate">{r.label}</div>
                      <div className="text-[11px] text-slate-500">
                        {r.cadence} · {r.hit_count} recent hits
                      </div>
                    </div>
                    <span className="text-[10px] uppercase text-slate-400">from rule</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function AssumptionsModal({ companyId, initial, onClose, onSaved }) {
  const [haircuts, setHaircuts] = useState(initial?.ar_haircuts || {});
  const [busy, setBusy] = useState(false);

  const setBucket = (k, v) => setHaircuts(prev => ({ ...prev, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      // Sanitize — convert 0-100 % display back to 0-1 fraction.
      const clean = {};
      for (const [k, v] of Object.entries(haircuts)) {
        const n = Math.max(0, Math.min(1, parseFloat(v)));
        if (!Number.isNaN(n)) clean[k] = n;
      }
      await api.post(`/companies/${companyId}/projections/settings`, { ar_haircuts: clean });
      toast.success("Assumptions saved.");
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="projections-assumptions-modal"
      >
        <div>
          <h3 className="font-heading font-semibold text-lg">AR collection assumptions</h3>
          <p className="text-xs text-slate-500 mt-1">
            What % of outstanding invoices in each aging bucket do you actually expect to collect?
            The forecast weights AR inflows by these numbers.
          </p>
        </div>
        <div className="space-y-3">
          {Object.entries(HAIRCUT_LABELS).map(([k, label]) => (
            <div key={k} className="flex items-center gap-3">
              <label className="text-sm text-slate-700 flex-1">{label}</label>
              <input
                type="number"
                min="0" max="1" step="0.05"
                value={haircuts[k] ?? 0}
                onChange={(e) => setBucket(k, e.target.value)}
                className="border rounded-md px-2 py-1 text-sm w-24 font-mono-num"
                data-testid={`projections-haircut-${k}`}
              />
              <span className="text-xs text-slate-500 w-14 text-right">
                {Math.round(((haircuts[k] ?? 0) * 100))}% collected
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="px-4 py-1.5 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="projections-save-assumptions-btn"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}


function AddRecurringModal({ companyId, onClose, onSaved }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [nextDate, setNextDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isInflow, setIsInflow] = useState(true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!label.trim() || !amount) {
      toast.error("Label and amount are required.");
      return;
    }
    setBusy(true);
    try {
      const signed = (isInflow ? 1 : -1) * Math.abs(parseFloat(amount) || 0);
      await api.post(`/companies/${companyId}/projections/recurring`, {
        label: label.trim(), amount: signed, cadence, next_date: nextDate, active: true,
      });
      toast.success("Added.");
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="projections-add-recurring-modal"
      >
        <div>
          <h3 className="font-heading font-semibold text-lg">Add recurring cashflow</h3>
          <p className="text-xs text-slate-500 mt-1">
            Anything the AI hasn't caught yet — retainers, subscriptions, a
            client on an annual plan, quarterly estimated tax, etc.
          </p>
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-xs text-slate-500 mb-1">Label</div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Monthly retainer — Acme Corp"
              className="w-full border rounded-md px-2 py-1.5 text-sm"
              data-testid="projections-recurring-label"
            />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <div className="text-xs text-slate-500 mb-1">Amount</div>
              <input
                type="number" step="0.01" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full border rounded-md px-2 py-1.5 text-sm font-mono-num"
                data-testid="projections-recurring-amount"
              />
            </div>
            <div className="w-32">
              <div className="text-xs text-slate-500 mb-1">Direction</div>
              <select
                value={isInflow ? "in" : "out"}
                onChange={(e) => setIsInflow(e.target.value === "in")}
                className="w-full border rounded-md px-2 py-1.5 text-sm"
                data-testid="projections-recurring-direction"
              >
                <option value="in">Inflow (+)</option>
                <option value="out">Outflow (−)</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <div className="text-xs text-slate-500 mb-1">Cadence</div>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                className="w-full border rounded-md px-2 py-1.5 text-sm"
                data-testid="projections-recurring-cadence"
              >
                {CADENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <div className="text-xs text-slate-500 mb-1">Next date</div>
              <input
                type="date" value={nextDate}
                onChange={(e) => setNextDate(e.target.value)}
                className="w-full border rounded-md px-2 py-1.5 text-sm"
                data-testid="projections-recurring-next-date"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="px-4 py-1.5 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="projections-recurring-save"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
