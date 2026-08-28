import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Loader2, Briefcase, TrendingUp, AlertTriangle, DollarSign,
  Calendar, Users, PieChart, Flame, LineChart, Clock, Layers,
  ArrowUpRight, ArrowDownRight, ArrowRight, Plus,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * ProjectsDashboard — /accounting/projects (Feb 2026, Phase E).
 *
 * A PM/owner control-room over the projects portfolio. Everything
 * hangs off /projects/dashboard (single round-trip). Layout:
 *   Row 1: 4 KPI cards
 *   Row 2: Pipeline timeline with 30/60/90/180 tabs
 *   Row 3: Cash-flow forecast bars + Project-type donut
 *   Row 4: At-risk projects + Variance leaderboard
 *   Row 5: Phase deadlines this week + Team allocation
 */
const BUCKETS = [30, 60, 90, 180];
const TYPE_COLORS = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#f97316", "#14b8a6"];

export default function ProjectsDashboard() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [bucket, setBucket] = useState(30);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api.get(`/companies/${currentId}/projects/dashboard`)
       .then(r => setData(r.data))
       .catch(e => toast.error(`Load failed: ${e.response?.data?.detail || e.message}`))
       .finally(() => setLoading(false));
  }, [currentId]);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="projects-dashboard">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center">
            <Briefcase size={22} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-amber-600 font-semibold">
              Projects · Dashboard
            </div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-slate-900">
              Portfolio at a glance
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {loading ? "Refreshing…"
                : `Last updated ${data?.generated_at?.slice(11, 16) || "—"}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/accounting/projects/list"
                data-testid="projects-dashboard-list-link"
                className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5">
            <Layers size={13} /> All projects
          </Link>
          <Link to="/accounting/projects/list?new=1"
                className="text-sm px-3 py-1.5 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700 inline-flex items-center gap-1.5">
            <Plus size={13} /> New project
          </Link>
        </div>
      </div>

      {loading && !data && (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 size={24} className="animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* Row 1: KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="projects-dashboard-kpis">
            <KpiCard label="Active projects" value={data.kpis.active_count}
                      icon={Briefcase} tone="amber"
                      sub={`${data.type_mix.length} types`} />
            <KpiCard label="Backlog value" value={fmt(data.kpis.backlog_value)}
                      icon={LineChart} tone="cyan"
                      sub="sum of open estimates" />
            <KpiCard label="At risk"
                      value={data.kpis.at_risk_count}
                      icon={AlertTriangle}
                      tone={data.kpis.at_risk_count > 0 ? "rose" : "emerald"}
                      sub={data.kpis.at_risk_count > 0 ? "needs attention" : "all clear"} />
            <KpiCard label="Expected · next 90d"
                      value={fmt(data.kpis.expected_90d)}
                      icon={TrendingUp} tone="violet"
                      sub="based on end-date × estimate" />
          </div>

          {/* Row 2: Pipeline timeline */}
          <PipelineCard data={data} bucket={bucket} setBucket={setBucket} fmt={fmt} nav={nav} />

          {/* Row 3: Cash-flow + type mix */}
          <div className="grid lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <CashFlowCard rows={data.cash_flow} fmt={fmt} />
            </div>
            <TypeMixCard rows={data.type_mix} fmt={fmt} />
          </div>

          {/* Row 4: At-risk + variance */}
          <div className="grid lg:grid-cols-2 gap-3">
            <AtRiskCard rows={data.at_risk} fmt={fmt} nav={nav} />
            <VarianceCard rows={data.variance} fmt={fmt} nav={nav} />
          </div>

          {/* Row 5: Phase deadlines + team allocation */}
          <div className="grid lg:grid-cols-2 gap-3">
            <PhaseDeadlinesCard rows={data.phase_deadlines} nav={nav} />
            <TeamAllocationCard rows={data.team_allocation} nav={nav} />
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// Cards
// ============================================================
const TONES = {
  amber:   { bg: "bg-amber-50",   text: "text-amber-600",   dot: "bg-amber-500" },
  cyan:    { bg: "bg-cyan-50",    text: "text-cyan-600",    dot: "bg-cyan-500" },
  violet:  { bg: "bg-violet-50",  text: "text-violet-600",  dot: "bg-violet-500" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600", dot: "bg-emerald-500" },
  rose:    { bg: "bg-rose-50",    text: "text-rose-600",    dot: "bg-rose-500" },
  slate:   { bg: "bg-slate-100",  text: "text-slate-500",   dot: "bg-slate-400" },
};

function KpiCard({ label, value, sub, icon: Icon, tone }) {
  const t = TONES[tone] || TONES.slate;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4"
          data-testid={`projects-dashboard-kpi-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            {label}
          </div>
          <div className="mt-2 font-heading text-2xl font-bold text-slate-900 tabular-nums">
            {value}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>
        </div>
        <div className={`w-8 h-8 rounded-md ${t.bg} ${t.text} flex items-center justify-center`}>
          <Icon size={14} />
        </div>
      </div>
    </div>
  );
}

function PipelineCard({ data, bucket, setBucket, fmt, nav }) {
  const items = data.buckets[String(bucket)] || [];
  const s = data.bucket_summary[String(bucket)] || {};
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4"
              data-testid="projects-dashboard-pipeline">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-amber-600" />
          <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
            Pipeline · next {bucket} days
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {BUCKETS.map(b => (
            <button key={b} onClick={() => setBucket(b)}
                    data-testid={`projects-dashboard-bucket-${b}`}
                    className={`text-[11px] px-2 py-1 rounded-md font-semibold ${
                      bucket === b
                        ? "bg-amber-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}>
              {b}d
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4 mb-3 text-[11px] text-slate-600">
        <span><b className="text-slate-900 tabular-nums">{s.count || 0}</b> projects ending</span>
        <span><b className="text-slate-900 tabular-nums">{s.phase_count || 0}</b> phase deadlines</span>
        <span className="ml-auto">Expected revenue&nbsp;
          <b className="text-slate-900 tabular-nums">{fmt(s.expected_revenue || 0)}</b>
        </span>
      </div>
      {items.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          Nothing lands in this window — clear runway ahead.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map(it => (
            <li key={`${it.kind}-${it.id}`}
                onClick={() => nav(`/accounting/projects/${it.project_id || it.id}`)}
                className="py-2 flex items-center gap-3 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                data-testid={`projects-dashboard-pipeline-${it.kind}-${it.id}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                it.kind === "phase" ? "bg-cyan-500" : "bg-amber-500"
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-900 truncate">
                  {it.kind === "phase" && (
                    <span className="text-[10px] uppercase tracking-wider text-cyan-700 mr-1">phase</span>
                  )}
                  {it.name}
                  {it.project_name && (
                    <span className="text-slate-400 text-xs">
                      &nbsp;· {it.project_name}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 flex items-center gap-1.5 truncate">
                  <span>{it.contact_name || "—"}</span>
                  <span>·</span>
                  <span className="inline-block px-1 rounded bg-slate-100 text-[10px] uppercase tracking-wider">
                    {it.project_type}
                  </span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-semibold text-slate-900 tabular-nums">
                  {it.estimated_revenue > 0 ? fmt(it.estimated_revenue) : "—"}
                </div>
                <div className="text-[10px] text-slate-500 tabular-nums">
                  ends {it.end_date}
                </div>
              </div>
              <ArrowRight size={12} className="text-slate-300 shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CashFlowCard({ rows, fmt }) {
  const max = Math.max(1, ...rows.map(r => r.expected_revenue));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full"
              data-testid="projects-dashboard-cashflow">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign size={14} className="text-emerald-600" />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          Cash flow forecast · next 6 months
        </h2>
      </div>
      <div className="flex items-end gap-3 h-40">
        {rows.map(r => {
          const h = (r.expected_revenue / max) * 100;
          return (
            <div key={r.month} className="flex-1 flex flex-col items-center gap-1"
                  data-testid={`projects-dashboard-cashflow-${r.month}`}>
              <div className="text-[10px] tabular-nums text-slate-700 font-semibold">
                {r.expected_revenue > 0 ? fmt(r.expected_revenue) : ""}
              </div>
              <div className="w-full flex-1 flex items-end">
                <div className="w-full rounded-t bg-gradient-to-t from-emerald-500 to-emerald-300"
                      style={{ height: `${Math.max(h, 2)}%`,
                                opacity: r.expected_revenue > 0 ? 1 : 0.15 }}
                      title={fmt(r.expected_revenue)} />
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 text-center">
                {r.label}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TypeMixCard({ rows, fmt }) {
  const totalCount = rows.reduce((a, r) => a + r.count, 0) || 1;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full flex flex-col"
              data-testid="projects-dashboard-typemix">
      <div className="flex items-center gap-2 mb-3">
        <PieChart size={14} className="text-violet-600" />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          Project mix
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-400 italic flex-1 flex items-center justify-center">
          No active projects yet.
        </div>
      ) : (
        <>
          <SvgDonut rows={rows} totalCount={totalCount} />
          <ul className="mt-3 space-y-1">
            {rows.map((r, i) => (
              <li key={r.type} className="flex items-center gap-1.5 text-[11px]"
                  data-testid={`projects-dashboard-typemix-${r.type}`}>
                <span className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: TYPE_COLORS[i % TYPE_COLORS.length] }} />
                <span className="text-slate-800 truncate flex-1">{r.type}</span>
                <span className="text-slate-500 tabular-nums">{r.count}</span>
                <span className="text-slate-400 tabular-nums text-[10px]">
                  {Math.round(r.count / totalCount * 100)}%
                </span>
                <span className="text-slate-700 tabular-nums font-medium ml-1">
                  {fmt(r.value)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SvgDonut({ rows, totalCount }) {
  // Assemble donut slices.
  const R = 40, C = 2 * Math.PI * R;
  let acc = 0;
  const slices = rows.map((r, i) => {
    const pct = r.count / totalCount;
    const dash = pct * C;
    const gap = C - dash;
    const offset = -acc;
    acc += dash;
    return { color: TYPE_COLORS[i % TYPE_COLORS.length], dash, gap, offset };
  });
  return (
    <div className="flex justify-center">
      <svg width="140" height="140" viewBox="0 0 100 100" className="-rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" stroke="#f1f5f9" strokeWidth="14" />
        {slices.map((s, i) => (
          <circle key={i} cx="50" cy="50" r={R} fill="none"
                  stroke={s.color} strokeWidth="14"
                  strokeDasharray={`${s.dash} ${s.gap}`}
                  strokeDashoffset={s.offset} />
        ))}
      </svg>
    </div>
  );
}

function AtRiskCard({ rows, fmt, nav }) {
  return (
    <section className={`rounded-xl border p-4 h-full ${
      rows.length > 0 ? "border-rose-200 bg-rose-50/40" : "border-slate-200 bg-white"
    }`} data-testid="projects-dashboard-atrisk">
      <div className="flex items-center gap-2 mb-3">
        <Flame size={14} className={rows.length > 0 ? "text-rose-600" : "text-emerald-600"} />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          At risk
        </h2>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-slate-500">
          {rows.length} project{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          Nothing on fire — nice work.
        </div>
      ) : (
        <ul className="divide-y divide-rose-100">
          {rows.slice(0, 6).map(r => (
            <li key={r.id}
                onClick={() => nav(`/accounting/projects/${r.id}`)}
                className="py-2 flex items-start gap-3 cursor-pointer hover:bg-rose-100/40 -mx-2 px-2 rounded"
                data-testid={`projects-dashboard-atrisk-${r.id}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-2 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-900 truncate font-medium">{r.name}</div>
                <div className="text-[11px] text-rose-700 mt-0.5">{r.reason}</div>
                <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                  {r.contact_name || "—"}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-semibold text-slate-900 tabular-nums">
                  {fmt(r.estimated_revenue)}
                </div>
                <div className="text-[10px] text-slate-500 tabular-nums">
                  spent {fmt(r.actual_cost)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VarianceCard({ rows, fmt, nav }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full"
              data-testid="projects-dashboard-variance">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={14} className="text-violet-600" />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          Estimate vs Actual · top 5
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          Add an estimate to your projects to see variance.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map(r => {
            const over = r.variance_pct > 0;
            const abs = Math.min(100, Math.abs(r.variance_pct));
            const Delta = over ? ArrowUpRight : ArrowDownRight;
            return (
              <li key={r.id}
                  onClick={() => nav(`/accounting/projects/${r.id}`)}
                  className="cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1.5 rounded"
                  data-testid={`projects-dashboard-variance-${r.id}`}>
                <div className="flex items-center gap-2 text-sm">
                  <div className="flex-1 text-slate-900 truncate font-medium">{r.name}</div>
                  <div className={`inline-flex items-center gap-0.5 tabular-nums text-[11px] font-semibold ${
                    over ? "text-rose-600" : "text-emerald-600"
                  }`}>
                    <Delta size={11} />
                    {over ? "+" : "−"}{Math.abs(r.variance_pct)}%
                  </div>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={over ? "bg-rose-500 h-full" : "bg-emerald-500 h-full"}
                        style={{ width: `${abs}%` }} />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
                  est {fmt(r.estimated_revenue)} · actual {fmt(r.actual_cost)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PhaseDeadlinesCard({ rows, nav }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full"
              data-testid="projects-dashboard-phase-deadlines">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={14} className="text-cyan-600" />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          Phase deadlines · next 7 days
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          No phases due this week. Take a breath.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map(r => (
            <li key={r.id}
                onClick={() => nav(`/accounting/projects/${r.project_id}`)}
                className="py-2 flex items-center gap-3 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                data-testid={`projects-dashboard-phase-${r.id}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-900 truncate font-medium">{r.name}</div>
                <div className="text-[11px] text-slate-500 truncate">
                  {r.project_name}
                </div>
              </div>
              <div className="text-[10px] tabular-nums text-cyan-700 uppercase tracking-wider shrink-0">
                {r.end_date}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamAllocationCard({ rows, nav }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full"
              data-testid="projects-dashboard-team-allocation">
      <div className="flex items-center gap-2 mb-3">
        <Users size={14} className="text-emerald-600" />
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          Team allocation · next 30 days
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          No one assigned to upcoming phases yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map(r => (
            <li key={r.user_id}
                className="rounded border border-slate-100 bg-slate-50/50 p-2"
                data-testid={`projects-dashboard-team-${r.user_id}`}>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[10px] uppercase font-bold flex items-center justify-center">
                  {(r.name || "?").slice(0, 2)}
                </div>
                <div className="text-sm text-slate-900 font-medium">{r.name}</div>
                <span className="ml-auto text-[10px] uppercase tracking-wider text-slate-500 tabular-nums">
                  {r.projects.length} project{r.projects.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {r.projects.map(p => (
                  <button key={p.project_id}
                          onClick={() => nav(`/accounting/projects/${p.project_id}`)}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:border-emerald-300 hover:text-emerald-700">
                    {p.project_name} · {p.phase_count}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
