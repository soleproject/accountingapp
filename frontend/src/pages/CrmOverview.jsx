import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Users, GitBranch, TrendingUp, Trophy, DollarSign, Target,
  Clock, AlertTriangle, ArrowRight, Plus, Loader2, Activity,
  StickyNote, Phone, Mail, CalendarCheck, Sparkles, Flame,
  ChevronRight, ChevronDown, Circle, Sun, LayoutDashboard,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { useCrmSettings, stageLabel } from "@/lib/useCrmSettings";
import DealDrawer from "@/components/DealDrawer";
import DealFormModal from "@/components/DealFormModal";
import MyDay from "@/pages/CrmMyDay";

/**
 * CrmOverview — /crm landing page (Phase D, Feb 2026).
 *
 * Turns the empty CRM shell into a live control room:
 *   • KPI band  — open value, weighted forecast, avg deal, win rate
 *   • Mini-Kanban strip — one chip per stage with count + $ rollup
 *   • Top deals + Stale deals — side-by-side accountability lists
 *   • Recent activity feed — flattened across every deal
 *
 * Everything is driven by GET /deals/overview so the page loads in
 * a single round-trip and stays fast even with 5k+ deals.
 */
const STAGE_TONE = {
  lead:        { chip: "bg-slate-100 text-slate-700 border-slate-200", dot: "bg-slate-400" },
  qualified:   { chip: "bg-cyan-100 text-cyan-800 border-cyan-200",     dot: "bg-cyan-500" },
  proposal:    { chip: "bg-indigo-100 text-indigo-800 border-indigo-200", dot: "bg-indigo-500" },
  negotiation: { chip: "bg-amber-100 text-amber-800 border-amber-200",   dot: "bg-amber-500" },
  won:         { chip: "bg-emerald-100 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
  lost:        { chip: "bg-rose-100 text-rose-800 border-rose-200",     dot: "bg-rose-400" },
};

const ACTIVITY_ICON = {
  note:         StickyNote,
  call:         Phone,
  email:        Mail,
  meeting:      CalendarCheck,
  stage_change: TrendingUp,
  system:       Sparkles,
};

export default function CrmOverview() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const crm = useCrmSettings();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedDealId, setSelectedDealId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  // "day" (My Day dashboard, default) | "pipeline" (existing pipeline KPIs).
  // Remembers the user's last choice per browser.
  const [view, setView] = useState(() => localStorage.getItem("crm_overview_view") || "day");
  useEffect(() => { localStorage.setItem("crm_overview_view", view); }, [view]);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/deals/overview`);
      setOverview(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const kpis = overview?.kpis;
  const openStages = useMemo(
    () => (overview?.by_stage || []).filter(s => !["won", "lost"].includes(s.stage)),
    [overview]);
  const totalOpenCount = kpis?.open_count || 0;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6" data-testid="crm-overview">
      {/* ---------- Header ---------- */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center">
            {view === "day" ? <Sun size={22}/> : <Users size={22} />}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-violet-600 font-semibold">
              CRM · {view === "day" ? "My Day" : "Overview"}
            </div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-slate-900">
              {view === "day" ? "Today, at a glance" : "Your pipeline, at a glance"}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {loading ? "Refreshing…"
                : view === "day"
                  ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
                  : `Last updated ${overview?.generated_at?.slice(11, 16) || "—"}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* View toggle */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
               data-testid="crm-view-toggle">
            <button
              onClick={() => setView("day")}
              data-testid="crm-view-day"
              className={`px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition ${
                view === "day"
                  ? "bg-violet-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}>
              <Sun size={12}/> My Day
            </button>
            <button
              onClick={() => setView("pipeline")}
              data-testid="crm-view-pipeline"
              className={`px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition ${
                view === "pipeline"
                  ? "bg-violet-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}>
              <LayoutDashboard size={12}/> Pipeline
            </button>
          </div>
          <button onClick={() => setShowNew(true)}
                  data-testid="crm-overview-new-deal"
                  className="text-sm px-3 py-1.5 rounded-md bg-violet-600 text-white font-medium hover:bg-violet-700 inline-flex items-center gap-1.5">
            <Plus size={13} /> New deal
          </button>
          <Link to="/crm/deals?product=crm"
                data-testid="crm-overview-open-board"
                className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5">
            <GitBranch size={13} /> Kanban board
          </Link>
        </div>
      </div>

      {/* ---------- My Day view ---------- */}
      {view === "day" && <MyDay onOpenDeal={setSelectedDealId} />}

      {view === "pipeline" && loading && !overview && (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 size={24} className="animate-spin" />
        </div>
      )}

      {view === "pipeline" && overview && (
        <>
          {/* ---------- KPI Band ---------- */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="crm-overview-kpis">
            <KpiCard label="Open pipeline"
                      value={fmt(kpis.open_value)}
                      sub={`${kpis.open_count} open ${pluralize("deal", kpis.open_count)}`}
                      icon={Target}
                      tone="violet"
                      testId="kpi-open-pipeline" />
            <KpiCard label="Weighted forecast"
                      value={fmt(kpis.weighted)}
                      sub="value × probability"
                      icon={TrendingUp}
                      tone="cyan"
                      testId="kpi-weighted" />
            <KpiCard label="Avg open deal"
                      value={fmt(kpis.avg_open_deal)}
                      sub={kpis.open_count > 0 ? "across open pipeline" : "no open deals"}
                      icon={DollarSign}
                      tone="amber"
                      testId="kpi-avg-deal" />
            <KpiCard label="Win rate (90d)"
                      value={`${kpis.win_rate_90d}%`}
                      sub={`${kpis.won_mtd_count} won this month · ${fmt(kpis.won_mtd_value)}`}
                      icon={Trophy}
                      tone="emerald"
                      testId="kpi-win-rate" />
          </div>

          {/* ---------- Mini-Kanban strip ---------- */}
          <section className="rounded-xl border border-slate-200 bg-white p-4"
                    data-testid="crm-overview-mini-kanban">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-violet-500" />
                <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
                  Pipeline snapshot
                </h2>
              </div>
              <Link to="/crm/deals?product=crm"
                    className="text-[11px] text-violet-600 hover:underline inline-flex items-center gap-0.5">
                Open board <ArrowRight size={11} />
              </Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
              {(overview.by_stage || []).map(s => {
                const tone = STAGE_TONE[s.stage] || STAGE_TONE.lead;
                const label = stageLabel(crm, s.stage);
                // Progress bar width relative to the biggest open stage
                // (won/lost sit outside so we compare only within open).
                const maxOpen = Math.max(
                  ...openStages.map(x => x.value_sum), 1);
                const width = ["won", "lost"].includes(s.stage)
                  ? 100
                  : Math.max(4, (s.value_sum / maxOpen) * 100);
                return (
                  <Link key={s.stage}
                        to={`/crm/deals?product=crm&stage=${s.stage}`}
                        data-testid={`crm-overview-stage-${s.stage}`}
                        className="rounded-lg border border-slate-200 hover:border-violet-300 hover:shadow-sm bg-white p-2.5 transition group">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                        {label}
                      </div>
                      <ChevronRight size={11} className="ml-auto text-slate-300 group-hover:text-violet-500" />
                    </div>
                    <div className="text-lg font-heading font-bold text-slate-900 tabular-nums">
                      {s.count}
                    </div>
                    <div className="text-[11px] text-slate-500 tabular-nums truncate">
                      {fmt(s.value_sum)}
                    </div>
                    <div className="mt-2 h-1 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`${tone.dot} h-full`}
                            style={{ width: `${width}%` }} />
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>

          {/* ---------- Top deals + Stale deals ---------- */}
          <div className="grid lg:grid-cols-2 gap-4">
            <ListCard
              title="Top open deals"
              icon={Flame}
              tone="orange"
              emptyLabel={totalOpenCount === 0
                ? "No open deals yet — start your pipeline."
                : "Nothing here."}
              testId="crm-overview-top">
              {(overview.top_deals || []).map(d => (
                <DealRow key={d.id}
                          deal={d}
                          fmt={fmt}
                          crm={crm}
                          onClick={() => setSelectedDealId(d.id)}
                          testId={`crm-overview-top-deal-${d.id}`}
                          highlight="value" />
              ))}
            </ListCard>

            <ListCard
              title={`Stale deals · ${overview.stale_days}+ days`}
              icon={AlertTriangle}
              tone="amber"
              emptyLabel="Nothing gathering dust — nice."
              testId="crm-overview-stale">
              {(overview.stale_deals || []).map(d => (
                <DealRow key={d.id}
                          deal={d}
                          fmt={fmt}
                          crm={crm}
                          onClick={() => setSelectedDealId(d.id)}
                          testId={`crm-overview-stale-deal-${d.id}`}
                          highlight="age" />
              ))}
            </ListCard>
          </div>

          {/* ---------- Recent activity ---------- */}
          <CollapsibleActivity
            count={(overview.recent_activities || []).length}
            activities={overview.recent_activities || []}
            onOpenDeal={(id) => setSelectedDealId(id)}
          />
        </>
      )}

      {showNew && (
        <DealFormModal onClose={() => setShowNew(false)}
                        onSaved={() => { setShowNew(false); load(); }} />
      )}
      {selectedDealId && (
        <DealDrawer dealId={selectedDealId}
                    onClose={() => setSelectedDealId(null)}
                    onChanged={load} />
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================
function CollapsibleActivity({ count, activities, onOpenDeal }) {
  // Persist open/closed per user across sessions (localStorage).
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem("crm_overview_activity_open");
      return v === null ? true : v === "true";
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("crm_overview_activity_open", String(open)); }
    catch { /* ignore */ }
  }, [open]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4"
              data-testid="crm-overview-activity-feed">
      <button type="button"
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
              data-testid="crm-overview-activity-toggle"
              className={`w-full flex items-center justify-between text-left ${open ? "mb-3" : ""}`}>
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />}
          <Activity size={14} className="text-violet-500" />
          <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
            Recent activity
          </h2>
          {!open && count > 0 && (
            <span className="ml-1 text-[10px] text-slate-500 font-normal">
              · {count}
            </span>
          )}
        </div>
        <span className="text-[11px] text-slate-400">
          {open ? "across every deal" : "Show"}
        </span>
      </button>
      {open && (
        count === 0 ? (
          <div className="text-center text-xs text-slate-400 italic py-8">
            Log a call, email, or note on any deal to start the feed.
          </div>
        ) : (
          <ol className="divide-y divide-slate-100">
            {activities.map(a => {
              const Icon = ACTIVITY_ICON[a.kind] || Circle;
              return (
                <li key={a.id}
                    className="flex items-start gap-3 py-2 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded transition"
                    onClick={() => onOpenDeal(a.deal_id)}
                    data-testid={`crm-overview-activity-${a.id}`}>
                  <div className="w-6 h-6 rounded-full bg-violet-50 text-violet-500 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon size={11} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-800 line-clamp-1">
                      {a.body}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-slate-600 truncate max-w-[180px]">
                        {a.deal_title}
                      </span>
                      <span>·</span>
                      <span>{a.by_name || "System"}</span>
                      <span>·</span>
                      <span>{relTime(a.at)}</span>
                    </div>
                  </div>
                  <ChevronRight size={13} className="text-slate-300 mt-1" />
                </li>
              );
            })}
          </ol>
        )
      )}
    </section>
  );
}


function KpiCard({ label, value, sub, icon: Icon, tone, testId }) {
  const tones = {
    violet:  "bg-violet-50 text-violet-600",
    cyan:    "bg-cyan-50 text-cyan-600",
    amber:   "bg-amber-50 text-amber-600",
    emerald: "bg-emerald-50 text-emerald-600",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4"
          data-testid={testId}>
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          {label}
        </div>
        <div className={`w-7 h-7 rounded-md ${tones[tone]} flex items-center justify-center`}>
          <Icon size={13} />
        </div>
      </div>
      <div className="mt-2 font-heading text-2xl font-bold text-slate-900 tabular-nums truncate">
        {value}
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5 truncate">{sub}</div>
    </div>
  );
}

function ListCard({ title, icon: Icon, tone, children, emptyLabel, testId }) {
  const tones = {
    orange: "bg-orange-50 text-orange-600",
    amber:  "bg-amber-50 text-amber-600",
  };
  const empty = !children || (Array.isArray(children) && children.length === 0);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4"
              data-testid={testId}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-6 h-6 rounded-md ${tones[tone] || "bg-slate-100 text-slate-500"} flex items-center justify-center`}>
          <Icon size={12} />
        </div>
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          {title}
        </h2>
      </div>
      {empty ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          {emptyLabel}
        </div>
      ) : (
        <ol className="divide-y divide-slate-100">{children}</ol>
      )}
    </section>
  );
}

function DealRow({ deal, fmt, crm, onClick, testId, highlight }) {
  const tone = STAGE_TONE[deal.stage] || STAGE_TONE.lead;
  const label = stageLabel(crm, deal.stage);
  return (
    <li onClick={onClick}
        className="flex items-center gap-3 py-2 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded transition"
        data-testid={testId}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-900 truncate">{deal.title}</div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span className={`inline-block px-1.5 py-[1px] rounded border text-[9px] uppercase tracking-wider ${tone.chip}`}>
            {label}
          </span>
          {deal.contact_name && (
            <>
              <span>·</span>
              <span className="truncate max-w-[140px]">{deal.contact_name}</span>
            </>
          )}
          {highlight === "age" && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5 text-amber-700">
                <Clock size={9} /> {relTime(deal.updated_at || deal.created_at)}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold text-slate-900 tabular-nums">
          {fmt(deal.value)}
        </div>
        <div className="text-[10px] text-slate-500 tabular-nums">
          {deal.probability}%
        </div>
      </div>
      <ChevronRight size={13} className="text-slate-300 shrink-0" />
    </li>
  );
}

// ============================================================
// helpers
// ============================================================
function pluralize(word, n) {
  return n === 1 ? word : `${word}s`;
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
