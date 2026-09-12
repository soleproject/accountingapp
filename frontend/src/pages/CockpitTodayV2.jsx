import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  AlertTriangle, Clock, CheckCircle2, Sparkles, RefreshCw, ChevronRight,
  ChevronDown, Shield, Flame, Flag, TrendingDown, X, Activity,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Cockpit → Today v2 (parallel to /cockpit/today, experimental)
//
// Structure:
//   1. Big "N decisions today" counter + supporting tri-strip
//   2. Persistent client-health strip (chronic clients pinned)
//   3. One ranked queue — sorted by risk_bucket then age, confidence badges
//   4. Collapsed "N handled overnight — view" strip at the bottom
//
// Backend fields consumed (all additive on /api/cockpit/today):
//   - decisions_count
//   - counts_by_risk { compliance, high_risk, flagged, routine }
//   - items[].risk_bucket, needs_decision, age_days, confidence
// Plus:
//   - GET /api/cockpit/handled-overnight
//   - GET /api/cockpit/client-health
// ---------------------------------------------------------------------------

const BUCKET_META = {
  compliance: { label: "Compliance",  icon: Shield,       tone: "text-red-700",    ringHover: "hover:border-red-300" },
  high_risk:  { label: "High risk",   icon: Flame,        tone: "text-orange-700", ringHover: "hover:border-orange-300" },
  flagged:    { label: "Flagged",     icon: Flag,         tone: "text-amber-700",  ringHover: "hover:border-amber-300" },
  routine:    { label: "Routine",     icon: CheckCircle2, tone: "text-slate-500",  ringHover: "hover:border-slate-300" },
};

const TREND_META = {
  chronic:   { label: "chronic",   dot: "bg-red-500",    text: "text-red-700" },
  stalling:  { label: "stalling",  dot: "bg-amber-500",  text: "text-amber-700" },
  steady:    { label: "steady",    dot: "bg-slate-400",  text: "text-slate-500" },
  improving: { label: "improving", dot: "bg-emerald-500", text: "text-emerald-700" },
  new:       { label: "new",       dot: "bg-blue-400",   text: "text-blue-600" },
};

export default function CockpitTodayV2() {
  const nav = useNavigate();
  const [today, setToday] = useState(null);
  const [health, setHealth] = useState(null);
  const [overnight, setOvernight] = useState(null);
  const [overnightOpen, setOvernightOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissedClients, setDismissedClients] = useState(() => new Set());

  const load = async () => {
    setBusy(true);
    try {
      const [t, h, o] = await Promise.all([
        api.get(`/cockpit/today`, { params: { limit: 500 } }),
        api.get(`/cockpit/client-health`),
        api.get(`/cockpit/handled-overnight`),
      ]);
      setToday(t.data);
      setHealth(h.data);
      setOvernight(o.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load Cockpit 2.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const decisionsCount   = today?.decisions_count ?? 0;
  const informationalCount = (today?.items || []).filter((i) => !i.needs_decision).length;
  const handledCount     = overnight?.total ?? 0;

  // Ranked queue: only items where the ball is in the CPA's court.
  const ranked = useMemo(() => {
    const rank = { compliance: 0, high_risk: 1, flagged: 2, routine: 3 };
    const items = (today?.items || []).filter((i) => i.needs_decision);
    items.sort((a, b) => {
      const ra = rank[a.risk_bucket ?? "routine"] ?? 9;
      const rb = rank[b.risk_bucket ?? "routine"] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.age_days || 0) - (a.age_days || 0);
    });
    // Group by bucket for the section headers
    const groups = { compliance: [], high_risk: [], flagged: [], routine: [] };
    for (const it of items) (groups[it.risk_bucket ?? "routine"] ??= []).push(it);
    return groups;
  }, [today]);

  const chronicClients = useMemo(
    () => (health?.clients || []).filter((c) => !dismissedClients.has(c.company_id)),
    [health, dismissedClients]
  );

  const dismissClient = (cid) => {
    setDismissedClients((prev) => {
      const next = new Set(prev);
      next.add(cid);
      return next;
    });
  };

  const now = new Date();
  const greeting =
    now.getHours() < 12 ? "Good morning" :
    now.getHours() < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="p-6 max-w-[1280px] mx-auto" data-testid="cockpit-today-v2-page">
      {/* Greeting */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-slate-500">{greeting}.</p>
        <button
          onClick={load}
          disabled={busy}
          data-testid="cockpit-v2-refresh"
          className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Big decision counter */}
      <section
        className="mb-6 pb-6 border-b border-slate-200"
        data-testid="cockpit-v2-headline"
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <span
            className="font-heading font-bold text-slate-900 leading-none"
            style={{ fontSize: "clamp(3.5rem, 10vw, 6rem)" }}
            data-testid="cockpit-v2-decisions-count"
          >
            {decisionsCount}
          </span>
          <span className="text-xl text-slate-500">
            decision{decisionsCount === 1 ? "" : "s"} today
          </span>
        </div>
        <div className="mt-2 text-xs text-slate-500 flex items-center gap-3 flex-wrap">
          <span data-testid="cockpit-v2-informational-count">
            <span className="font-mono-num text-slate-700 font-semibold">{informationalCount}</span> informational
          </span>
          <span className="text-slate-300">·</span>
          <span data-testid="cockpit-v2-handled-count">
            <CheckCircle2 size={11} className="inline text-emerald-500 mr-0.5" />
            <span className="font-mono-num text-slate-700 font-semibold">{handledCount}</span> handled overnight
          </span>
        </div>
      </section>

      {/* Client health strip */}
      {chronicClients.length > 0 && (
        <section
          className="mb-6"
          data-testid="cockpit-v2-health-strip"
        >
          <div className="flex items-center gap-2 mb-2 text-slate-600">
            <Activity size={14} />
            <h2 className="text-[11px] font-semibold uppercase tracking-wider">
              Clients to watch
            </h2>
            <span className="text-[10px] text-slate-400">{chronicClients.length}</span>
          </div>
          <div className="grid gap-2 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {chronicClients.slice(0, 6).map((c) => {
              const t = TREND_META[c.trend] || TREND_META.new;
              return (
                <div
                  key={c.company_id}
                  className={`rounded-lg border p-3 bg-white transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 ${
                    c.chronic ? "border-red-200" : "border-slate-200"
                  }`}
                  data-testid={`cockpit-v2-health-card-${c.company_id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {c.company_name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                        <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
                        <span className={t.text}>{t.label}</span>
                        {c.max_stale_days > 0 && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-500">
                              <TrendingDown size={10} className="inline -mt-0.5 mr-0.5" />
                              {c.max_stale_days}d
                            </span>
                          </>
                        )}
                        {c.open_questions > 0 && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-500">{c.open_questions} open</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => dismissClient(c.company_id)}
                      className="text-slate-300 hover:text-slate-600 -mt-0.5 shrink-0"
                      title="Dismiss for today"
                      data-testid={`cockpit-v2-health-dismiss-${c.company_id}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <button
                    onClick={() => nav(`/cockpit/communications?company_ids=${c.company_id}&source=portal`)}
                    className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                    data-testid={`cockpit-v2-health-view-${c.company_id}`}
                  >
                    View <ChevronRight size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Ranked queue */}
      {decisionsCount === 0 ? (
        <div
          className="bg-white rounded-lg border border-slate-200 p-10 text-center"
          data-testid="cockpit-v2-empty"
        >
          <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={36} />
          <div className="text-lg font-semibold text-slate-900">Inbox zero.</div>
          <div className="text-sm text-slate-600 mt-1">
            Nothing needs your judgment right now.
          </div>
        </div>
      ) : (
        <section className="space-y-5" data-testid="cockpit-v2-queue">
          {["compliance", "high_risk", "flagged", "routine"].map((k) => {
            const items = ranked[k] || [];
            if (items.length === 0) return null;
            const meta = BUCKET_META[k];
            const Icon = meta.icon;
            return (
              <div key={k} data-testid={`cockpit-v2-bucket-${k}`}>
                <div className={`flex items-center gap-2 mb-2 ${meta.tone}`}>
                  <Icon size={14} />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider">
                    {meta.label}
                  </h2>
                  <span className="text-[10px] text-slate-400 font-normal">{items.length}</span>
                </div>
                <div className={`bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 transition-colors ${meta.ringHover}`}>
                  {items.map((it) => (
                    <QueueRow
                      key={it.id}
                      item={it}
                      onClick={() => nav(it.action_route)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* Handled overnight — collapsed footer */}
      {handledCount > 0 && (
        <section className="mt-8 pt-6 border-t border-slate-200" data-testid="cockpit-v2-overnight-strip">
          <button
            onClick={() => setOvernightOpen((v) => !v)}
            className="w-full text-left flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 transition-colors"
            data-testid="cockpit-v2-overnight-toggle"
          >
            {overnightOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span>
              <span className="font-semibold text-slate-800">{handledCount}</span>
              {" "}item{handledCount === 1 ? "" : "s"} handled overnight
            </span>
            <span className="text-xs text-slate-400 ml-auto">
              {overnight?.by_source ? (
                Object.entries(overnight.by_source)
                  .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ")
              ) : ""}
            </span>
          </button>
          {overnightOpen && (
            <div className="mt-3 bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-96 overflow-y-auto">
              {(overnight?.items || []).map((it) => (
                <div
                  key={it.id}
                  className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 cursor-pointer text-sm"
                  onClick={() => nav(it.route)}
                  data-testid={`cockpit-v2-overnight-item-${it.id}`}
                >
                  <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-slate-800">{it.title}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      <span className="font-medium text-slate-700">{it.company_name}</span>
                      {it.subtitle ? <span> · {it.subtitle}</span> : null}
                    </div>
                  </div>
                  {typeof it.confidence === "number" && (
                    <ConfidenceBadge confidence={it.confidence} />
                  )}
                </div>
              ))}
              {(overnight?.items || []).length === 0 && (
                <div className="px-4 py-6 text-sm text-slate-500 text-center">
                  Aggregate count only — no per-item detail available.
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────
function QueueRow({ item, onClick }) {
  return (
    <div
      className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 cursor-pointer"
      onClick={onClick}
      data-testid={`cockpit-v2-card-${item.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-900 truncate">
            {item.title}
          </span>
          {item.count > 1 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono-num">
              {item.count}
            </span>
          )}
          {typeof item.confidence === "number" && (
            <ConfidenceBadge confidence={item.confidence} />
          )}
          {item.age_days > 0 && (
            <span
              className={`text-[10px] font-mono-num ${
                item.age_days >= 7 ? "text-red-600" :
                item.age_days >= 3 ? "text-amber-600" : "text-slate-400"
              }`}
              title="Days since first surfaced"
            >
              <Clock size={9} className="inline -mt-0.5 mr-0.5" />
              {item.age_days}d
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 truncate">
          <span className="font-medium text-slate-700">{item.company_name}</span>
          {item.subtitle ? <span> · {item.subtitle}</span> : null}
        </div>
      </div>
      <button
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium shrink-0"
        data-testid={`cockpit-v2-action-${item.id}`}
      >
        {item.action_label} →
      </button>
    </div>
  );
}

// ── Confidence badge — 3 tiers for readability ───────────────────────
function ConfidenceBadge({ confidence }) {
  const pct = Math.round(confidence * 100);
  const tone =
    pct >= 90 ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    pct >= 70 ? "bg-amber-50 text-amber-700 border-amber-200" :
                "bg-slate-100 text-slate-600 border-slate-300";
  return (
    <span
      className={`text-[10px] font-mono-num px-1.5 py-0.5 rounded border ${tone}`}
      title="AI confidence"
    >
      {pct}%
    </span>
  );
}
