/**
 * CashFlowMonitorCard — inline snapshot of the Projections engine.
 *
 * Row is green + folded when the account has healthy runway (>120d),
 * amber when runway is 60-120d, red when runway <60d. The dropdown
 * mirrors screenshot 2: a horizon number bar (Today / +30 / +60 / +90
 * / +120 / Runway) plus a Burn Reconciliation panel and a link into
 * the full Projections page (with return breadcrumb).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, TrendingDown, ArrowRight, Zap, LineChart as LineChartIcon } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import ClientCockpitCard from "./ClientCockpitCard";

const HEALTH_TONE = {
  healthy:  "green",
  warning:  "amber",
  critical: "red",
};

const HEALTH_LABEL = {
  healthy:  "Healthy runway",
  warning:  "Watch runway",
  critical: "Cash issue",
};

const iso = (s) => (s ? String(s).slice(0, 10) : "");

export default function CashFlowMonitorCard({ companyId }) {
  const fmt = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/cockpit-cards/cashflow-snapshot`);
      setData(r.data);
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const tone = HEALTH_TONE[data?.health] || "slate";
  const label = HEALTH_LABEL[data?.health] || "Loading…";
  const runwayText = data?.runway_days == null
    ? "no runway drag"
    : data.runway_days >= 3650
      ? "long runway"
      : `~${Math.round(data.runway_days)}d runway`;
  const subtitle = data
    ? `Cash today ${fmt(data.cash_today || 0)} · ${runwayText} · burn ${fmt(Math.abs(data.forward_monthly_burn || 0))}/mo`
    : "Loading projections…";
  const openLink = `${data?.open_link || "/accounting/projections"}?return_to=${encodeURIComponent("/cockpit/client")}&return_label=${encodeURIComponent("Back to Client Cockpit")}`;

  const snaps = data?.snapshots || [];
  const br = data?.burn_reconciliation || {};

  return (
    <ClientCockpitCard
      testid="card-cashflow-monitor"
      icon={<Activity size={16} className={tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-emerald-600"} />}
      title="Monitoring Cash Flow"
      subtitle={subtitle}
      statusLabel={label}
      statusTone={tone}
      isOpen={open}
      onToggle={() => setOpen(v => !v)}
      onRefresh={load}
      refreshing={busy}
      disabled={!data}
    >
      {data && (
        <div className="space-y-3">
          {/* Number bar — mirrors screenshot 2 */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2" data-testid="cashflow-number-bar">
            <NumberCell label="Today" value={fmt(data.cash_today || 0)} asOf={iso(data.as_of)} />
            {snaps.map(s => (
              <NumberCell
                key={s.days}
                label={`+${s.days} days`}
                value={fmt(s.cash || 0)}
                asOf={iso(s.date)}
                delta={s.delta}
                fmt={fmt}
                bad={s.cash < 0}
              />
            ))}
            <RunwayCell
              days={data.runway_days}
              burn={data.forward_monthly_burn}
              fmt={fmt}
            />
          </div>

          {/* Burn reconciliation panel */}
          <div className="rounded-lg border bg-white p-3" data-testid="cashflow-burn-reco">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold flex items-center gap-1">
              <TrendingDown size={11} /> Burn reconciliation
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              How the forecast matches what actually happens.
              <span className="text-slate-400"> Trailing {br.lookback_days || 180} days.</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
              <BurnPanel
                label="Historical monthly (fact)"
                tone="slate"
                lines={[
                  { icon: "↑", text: "Money in", value: fmt(br.historical_monthly_in || 0), positive: true },
                  { icon: "↓", text: "Money out", value: fmt(-(Math.abs(br.historical_monthly_out || 0))), positive: false },
                  { text: "Net", value: fmt(br.historical_monthly_net || 0), bold: true, positive: (br.historical_monthly_net || 0) >= 0 },
                ]}
                hint="Straight from bank transactions. The anchor — no guessing."
              />
              <BurnPanel
                label="Explained by forecast"
                tone="blue"
                bigValue={fmt(br.scheduled_next_30d_net || 0)}
                bigSuffix="next 30 days"
                progress={100}
                hint="Historical net covered by scheduled events + detected patterns."
              />
              <BurnPanel
                label="Unexplained residual"
                tone="amber"
                bigValue={fmt(br.unexplained_residual_monthly || 0)}
                bigSuffix="/ month"
                hint="One-off activity: contractors, ad-hoc supplies, transfers. Spread across the forecast so it still lands the right number."
              />
            </div>
          </div>

          {/* Cash forecast chart — same visual language as the full
              Projections page (blue area, ref line at $0). */}
          {data.timeline?.length > 1 && (
            <div className="rounded-lg border bg-white p-3" data-testid="cashflow-chart">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold flex items-center gap-1">
                    <LineChartIcon size={11} /> Cash forecast · next {data.horizon_days} days
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 font-mono-num">
                    {iso(data.as_of)} → {iso(data.horizon_end)}
                  </div>
                </div>
              </div>
              <div className="h-48 w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.timeline} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                    <defs>
                      <linearGradient id="cockpitCashArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                      domain={[(dataMin) => Math.min(dataMin, 0), "auto"]}
                    />
                    <Tooltip
                      formatter={(v) => fmt(v)}
                      labelFormatter={(l) => `On ${l}`}
                      contentStyle={{ borderRadius: 6, fontSize: 12 }}
                    />
                    <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                    <Area type="monotone" dataKey="cash" stroke="#0891b2" fill="url(#cockpitCashArea)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Biggest events on the horizon */}
          {data.biggest_events?.length > 0 && (
            <div className="rounded-lg border bg-white p-3" data-testid="cashflow-biggest-events">
              <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold flex items-center gap-1">
                <Zap size={11} /> Biggest events on the horizon
              </div>
              <ul className="mt-1 divide-y divide-slate-100 text-xs">
                {data.biggest_events.map((e, idx) => (
                  <li key={idx} className="py-1 flex items-center justify-between gap-2">
                    <span className="text-slate-600 shrink-0 font-mono-num">{iso(e.date)}</span>
                    <span className="text-slate-900 truncate flex-1 mx-2">{e.label}</span>
                    <span className={`font-mono-num shrink-0 ${e.amount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {e.amount >= 0 ? "+" : ""}{fmt(e.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Link
            to={openLink}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
            data-testid="cashflow-open-projections"
          >
            Open full Projections <ArrowRight size={12} />
          </Link>
        </div>
      )}
    </ClientCockpitCard>
  );
}

function NumberCell({ label, value, asOf, delta, fmt, bad }) {
  return (
    <div className={`rounded-lg border p-2 ${bad ? "bg-red-50 border-red-200" : "bg-white border-slate-200"}`}>
      <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">{label}</div>
      <div className={`font-mono-num text-base font-semibold ${bad ? "text-red-700" : "text-slate-900"}`}>
        {value}
      </div>
      {typeof delta === "number" && fmt && (
        <div className={`text-[10px] font-mono-num ${delta < 0 ? "text-red-500" : "text-emerald-600"}`}>
          {delta < 0 ? "↓" : "↑"} {fmt(Math.abs(delta))} · {asOf}
        </div>
      )}
      {!delta && asOf && <div className="text-[10px] text-slate-400">{asOf}</div>}
    </div>
  );
}

function RunwayCell({ days, burn, fmt }) {
  const label = days == null ? "—" : days >= 365 ? `${(days / 365).toFixed(1)}y` : days >= 30 ? `${Math.round(days / 30)}mo` : `${Math.round(days)}d`;
  const tone = days == null ? "text-slate-700" : days < 60 ? "text-red-700" : days < 120 ? "text-amber-700" : "text-emerald-700";
  return (
    <div className="rounded-lg border bg-white border-slate-200 p-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Runway</div>
      <div className={`font-mono-num text-base font-semibold ${tone}`}>{label}</div>
      {typeof burn === "number" && (
        <div className="text-[10px] font-mono-num text-slate-500">
          burn {fmt(Math.abs(burn))}/mo
        </div>
      )}
    </div>
  );
}

function BurnPanel({ label, tone, lines, bigValue, bigSuffix, hint, progress }) {
  const toneClass = {
    slate: "bg-slate-50 border-slate-200",
    blue:  "bg-blue-50 border-blue-200",
    amber: "bg-amber-50 border-amber-200",
  }[tone] || "bg-slate-50 border-slate-200";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
      {lines && (
        <div className="mt-1 space-y-1 text-sm font-mono-num">
          {lines.map((l, i) => (
            <div key={i} className={`flex items-center justify-between ${l.bold ? "border-t border-slate-200 pt-1 mt-1 font-semibold" : ""}`}>
              <span className="text-slate-600 text-[11px] non-mono-font">{l.icon} {l.text}</span>
              <span className={l.positive ? "text-emerald-700" : "text-red-700"}>{l.value}</span>
            </div>
          ))}
        </div>
      )}
      {bigValue && (
        <div className="mt-1">
          <div className="text-2xl font-mono-num font-semibold text-slate-900">{bigValue}</div>
          {bigSuffix && <div className="text-[11px] text-slate-500">{bigSuffix}</div>}
          {typeof progress === "number" && (
            <div className="mt-1 h-1 rounded bg-white/60 overflow-hidden">
              <div className="h-full bg-blue-400" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}
      {hint && <div className="text-[10px] text-slate-500 mt-1.5">{hint}</div>}
    </div>
  );
}
