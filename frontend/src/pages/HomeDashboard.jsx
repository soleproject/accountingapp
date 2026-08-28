import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Loader2, ArrowRight, TrendingUp, TrendingDown, Users, GitBranch,
  Briefcase, Calculator, Sparkles, Clock, StickyNote, Phone, Mail,
  CalendarCheck, ClipboardCheck, DollarSign, Building2, ChevronRight,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * HomeDashboard — /home (Feb 2026, Phase D).
 *
 * A cross-product control-room that stitches Accounting, CRM,
 * Projects, and Team into one glanceable surface. The page renders
 * off a single /home-summary payload so we can add drag-reorder
 * (Phase 2) and AI-generated custom KPIs (Phase 3) without touching
 * the render layer.
 *
 * Widgets:
 *   kpi       — hero KPI card (row 1)
 *   donut     — team-health completion donut
 *   module    — per-product summary card w/ trend hint + link
 *   activity  — cross-product recent activity feed
 */
export default function HomeDashboard() {
  const { currentId, current } = useCompany();
  const currentName = current?.name;
  const fmt = useMoneyFmt();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/home-summary`);
      setData(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const widgets = data?.widgets || [];
  const kpis    = widgets.filter(w => w.kind === "kpi");
  const donut   = widgets.find(w => w.kind === "donut");
  const modules = widgets.filter(w => w.kind === "module");
  const feed    = widgets.find(w => w.kind === "activity");

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="home-dashboard">
      {/* -------- Header -------- */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Home
          </div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-slate-900">
            {greet()},&nbsp;
            <span className="text-slate-700">{currentName || "there"}</span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {loading ? "Refreshing…" :
              `Everything across Accounting · CRM · Projects · Team`}
          </p>
        </div>
        <button onClick={() => window.dispatchEvent(new Event("insights:open"))}
                data-testid="home-ask-ai"
                className="text-sm px-3 py-1.5 rounded-md border border-indigo-200 bg-gradient-to-br from-indigo-50 to-fuchsia-50 text-indigo-900 font-medium hover:from-indigo-100 hover:to-fuchsia-100 inline-flex items-center gap-1.5">
          <Sparkles size={13} /> Ask AI
        </button>
      </div>

      {loading && !data && (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 size={24} className="animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* -------- Row 1 : Hero KPI band + Donut -------- */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3"
                data-testid="home-hero-kpis">
            {kpis.map(w => (
              <KpiCard key={w.id} widget={w} fmt={fmt} />
            ))}
          </div>

          {/* -------- Row 2 : Team health + module cards -------- */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3"
                data-testid="home-modules-row">
            {donut && (
              <div className="lg:col-span-1">
                <DonutCard widget={donut} />
              </div>
            )}
            <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {modules.map(w => (
                <ModuleCard key={w.id} widget={w} fmt={fmt} />
              ))}
            </div>
          </div>

          {/* -------- Row 3 : Activity feed -------- */}
          {feed && <ActivityCard widget={feed} />}
        </>
      )}
    </div>
  );
}

// ============================================================
// Widget renderers
// ============================================================
const TONE = {
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600", dot: "bg-emerald-500", ring: "ring-emerald-100" },
  cyan:    { bg: "bg-cyan-50",    text: "text-cyan-600",    dot: "bg-cyan-500",    ring: "ring-cyan-100" },
  violet:  { bg: "bg-violet-50",  text: "text-violet-600",  dot: "bg-violet-500",  ring: "ring-violet-100" },
  amber:   { bg: "bg-amber-50",   text: "text-amber-600",   dot: "bg-amber-500",   ring: "ring-amber-100" },
  rose:    { bg: "bg-rose-50",    text: "text-rose-600",    dot: "bg-rose-500",    ring: "ring-rose-100" },
  slate:   { bg: "bg-slate-50",   text: "text-slate-600",   dot: "bg-slate-500",   ring: "ring-slate-100" },
};

const KPI_ICONS = {
  "kpi.revenue_mtd":     DollarSign,
  "kpi.employees":       Users,
  "kpi.pipeline":        TrendingUp,
  "kpi.active_projects": Briefcase,
};

function KpiCard({ widget, fmt }) {
  const tone = TONE[widget.tone] || TONE.slate;
  const Icon = KPI_ICONS[widget.id] || TrendingUp;
  const val = widget.value_kind === "currency" ? fmt(widget.value) : widget.value;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4"
          data-testid={`home-kpi-${widget.id}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            {widget.label}
          </div>
          <div className="mt-2 font-heading text-2xl font-bold text-slate-900 tabular-nums">
            {val}
          </div>
          {widget.sub && (
            <div className="text-[11px] text-slate-500 mt-0.5">{widget.sub}</div>
          )}
        </div>
        <div className={`w-8 h-8 rounded-md ${tone.bg} ${tone.text} flex items-center justify-center`}>
          <Icon size={14} />
        </div>
      </div>
    </div>
  );
}

function DonutCard({ widget }) {
  const pct = Math.max(0, Math.min(100, widget.percent || 0));
  // SVG donut — 40 radius, stroke 8.
  const R = 40, C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 h-full"
          data-testid={`home-donut-${widget.id}`}>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
        {widget.label}
      </div>
      <div className="flex items-center justify-center py-3">
        <div className="relative">
          <svg width="120" height="120" viewBox="0 0 100 100" className="-rotate-90">
            <circle cx="50" cy="50" r={R} fill="none"
                    stroke="#e2e8f0" strokeWidth="10" />
            <circle cx="50" cy="50" r={R} fill="none"
                    stroke={pct >= 60 ? "#10b981" : pct >= 40 ? "#f59e0b" : "#f43f5e"}
                    strokeWidth="10"
                    strokeDasharray={`${dash} ${C - dash}`}
                    strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="font-heading text-2xl font-bold text-slate-900 tabular-nums">
              {pct}%
            </div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">
              {widget.caption || ""}
            </div>
          </div>
        </div>
      </div>
      <ul className="space-y-1">
        {(widget.legend || []).map((leg, i) => {
          const tone = TONE[leg.tone] || TONE.slate;
          return (
            <li key={i} className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} />
              {leg.label}
              <span className="ml-auto tabular-nums font-medium text-slate-800">
                {leg.value}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const MODULE_ICONS = {
  "module.sales":    GitBranch,
  "module.projects": Briefcase,
  "module.team":     Building2,
  "module.finance":  Calculator,
};

function ModuleCard({ widget, fmt }) {
  const tone = TONE[widget.tone] || TONE.slate;
  const Icon = MODULE_ICONS[widget.id] || TrendingUp;
  const up = (widget.trend_hint || "").startsWith("+");
  const TrendIcon = up ? TrendingUp : TrendingDown;
  const trendCls = up ? "text-emerald-600" : "text-slate-500";
  return (
    <Link to={widget.link}
          data-testid={`home-module-${widget.id}`}
          className="rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300 hover:shadow-sm transition group block">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-7 h-7 rounded-md ${tone.bg} ${tone.text} flex items-center justify-center`}>
          <Icon size={13} />
        </div>
        <h3 className="font-heading text-sm font-bold text-slate-900">
          {widget.label}
        </h3>
        <ChevronRight size={12}
          className="ml-auto text-slate-300 group-hover:text-slate-600 group-hover:translate-x-0.5 transition-transform" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(widget.metrics || []).map((m, i) => (
          <div key={i}>
            <div className="font-heading text-xl font-bold text-slate-900 tabular-nums">
              {m.kind === "currency" ? fmt(m.value) : (m.value ?? 0)}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {m.label}
            </div>
          </div>
        ))}
      </div>
      {widget.trend_hint && (
        <div className={`mt-3 text-[11px] ${trendCls} inline-flex items-center gap-1`}>
          <TrendIcon size={11} /> {widget.trend_hint}
        </div>
      )}
      <div className={`mt-2 text-[11px] ${tone.text} inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition`}>
        View dashboard <ArrowRight size={11} />
      </div>
    </Link>
  );
}

const ACTIVITY_ICONS = {
  note:         StickyNote,
  call:         Phone,
  email:        Mail,
  meeting:      CalendarCheck,
  task:         ClipboardCheck,
  time:         Clock,
  stage_change: TrendingUp,
  system:       Sparkles,
};
const SOURCE_TONE = { crm: "violet", team: "cyan", accounting: "emerald", projects: "amber" };

function ActivityCard({ widget }) {
  const items = widget.items || [];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4"
              data-testid="home-activity-feed">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          {widget.label}
        </h2>
        <span className="text-[11px] text-slate-400">
          across every product
        </span>
      </div>
      {items.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-8">
          Log activity anywhere and it'll show up here.
        </div>
      ) : (
        <ol className="divide-y divide-slate-100">
          {items.map(a => {
            const Icon = ACTIVITY_ICONS[a.kind] || StickyNote;
            const tone = TONE[SOURCE_TONE[a.source]] || TONE.slate;
            return (
              <li key={a.id}
                  className="flex items-start gap-3 py-2"
                  data-testid={`home-activity-${a.id}`}>
                <div className={`w-6 h-6 rounded-full ${tone.bg} ${tone.text} flex items-center justify-center shrink-0 mt-0.5`}>
                  <Icon size={11} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-800 line-clamp-1">
                    {a.body}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className={`uppercase tracking-wider ${tone.text} font-semibold`}>
                      {a.source}
                    </span>
                    {a.link_label && (
                      <>
                        <span>·</span>
                        <span className="text-slate-600 truncate max-w-[220px]">
                          {a.link_label}
                        </span>
                      </>
                    )}
                    {a.by_name && (
                      <>
                        <span>·</span>
                        <span>{a.by_name}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>{relTime(a.at)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ============================================================
// helpers
// ============================================================
function greet() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  const mo = Math.floor(diff / (30 * 86400));
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}
