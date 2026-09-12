import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Clock, CheckCircle2, RefreshCw, ChevronRight, ChevronDown,
  Flag, Flame, TrendingDown, X, Activity, Loader2, Calendar,
  Sparkles, ChevronLeft, Bot,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Cockpit → Today v2  (parallel to /cockpit/today)
//
// Design principles this page enforces:
//   • The headline number counts ONLY judgment calls (high_risk +
//     flagged). Rubber-stamp auto-passed items go to Quick Approvals.
//   • Quick Approvals batch by client with one-click bulk-approve so
//     the CPA doesn't scroll past 20 identical sign-off rows.
//   • Client-health (chronic clients) lives in a persistent strip
//     that's always visible even when nothing about them is red today.
//   • "Handled overnight" is a collapsed footer, not a lead section —
//     proof exists, one click to inspect.
// ---------------------------------------------------------------------------

const TREND_META = {
  chronic:   { label: "chronic",   dot: "bg-red-500",    text: "text-red-700" },
  stalling:  { label: "stalling",  dot: "bg-amber-500",  text: "text-amber-700" },
  steady:    { label: "steady",    dot: "bg-slate-400",  text: "text-slate-500" },
  improving: { label: "improving", dot: "bg-emerald-500", text: "text-emerald-700" },
  new:       { label: "new",       dot: "bg-blue-400",   text: "text-blue-600" },
};

// Which item ids map to which month-close checkpoint kind. Backend
// stamps ids as `signoff-{cid}-{kind}` for individual checkpoints,
// `close-ready-{cid}` for the composite ready-to-close card, and
// `signoff-approved-{cid}-{ym}` for a client-approved period (which
// on the CPA side becomes a `closed` checkpoint lock).
function extractCheckpointKind(item) {
  const id = item.id || "";
  if (id.startsWith("close-ready-")) return "closed";
  if (id.startsWith("signoff-approved-")) return "closed";
  if (id.startsWith("signoff-")) {
    const parts = id.split("-");
    const last = parts[parts.length - 1];
    if (["recon", "invoices", "bills", "txns_reviewed", "closed"].includes(last)) return last;
  }
  return null;
}

function extractYm(item) {
  const m = (item.action_route || "").match(/ym=(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

// Collapse items that share an `event_key` into a single group. Items
// without an event_key become their own singleton group so distinct
// events (an advisor report on ONE client) stay visually prominent
// even when other groups have 15+ members.
function groupByEventKey(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.event_key || `__solo:${it.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        event_key: it.event_key || null,
        // Representative fields — used for the collapsed header when
        // the group has 2+ items. Individual clients still expand
        // beneath.
        title: it.title,
        subtitle: it.subtitle,
        action_label: it.action_label,
        risk_bucket: it.risk_bucket,
        items: [],
      });
    }
    groups.get(key).items.push(it);
  }
  return Array.from(groups.values());
}

export default function CockpitTodayV2() {
  const nav = useNavigate();
  const [today, setToday] = useState(null);
  const [health, setHealth] = useState(null);
  const [overnight, setOvernight] = useState(null);
  const [overnightOpen, setOvernightOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissedClients, setDismissedClients] = useState(() => new Set());
  const [approving, setApproving] = useState(new Set());
  const [collapsedTail, setCollapsedTail] = useState(true);

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

  const decisionsCount = today?.decisions_count ?? 0;
  const counts        = today?.counts_by_risk || {};
  const routineTotal  = counts.routine ?? 0;
  const handledCount  = overnight?.total ?? 0;

  // Split items three ways + upcoming deadlines section.
  const { judgment, quickApprovals, upcomingDeadlines } = useMemo(() => {
    const items = today?.items || [];
    const judgmentRaw = [];
    const upcomingRaw = [];
    const routineByClient = new Map(); // cid → { company_name, items[] }
    for (const it of items) {
      const bucket = it.risk_bucket;
      if (bucket === "high_risk" || bucket === "flagged") {
        judgmentRaw.push(it);
      } else if (bucket === "upcoming_deadline") {
        upcomingRaw.push(it);
      } else if (bucket === "routine") {
        const cid = it.company_id || "_firm";
        if (!routineByClient.has(cid)) {
          routineByClient.set(cid, {
            company_id: cid,
            company_name: it.company_name || "Firm-wide",
            items: [],
          });
        }
        routineByClient.get(cid).items.push(it);
      }
      // waiting_on_client → skipped; surfaced via Client Health strip
    }

    // Group judgment items by event_key so identical events across
    // clients (e.g. "advisor report ready" across 5 clients) collapse
    // to one row with an expand affordance. Items without an
    // event_key stay as their own singleton "group".
    const groupJudgment = groupByEventKey(judgmentRaw);
    // Sort groups: high_risk before flagged, then by age of the
    // representative item, then by size (bigger groups later so tiny
    // distinct items don't get buried).
    groupJudgment.sort((a, b) => {
      const ra = a.risk_bucket === "high_risk" ? 0 : 1;
      const rb = b.risk_bucket === "high_risk" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ageA = a.items[0]?.age_days || 0;
      const ageB = b.items[0]?.age_days || 0;
      if (ageA !== ageB) return ageB - ageA;
      return a.items.length - b.items.length;
    });

    // Upcoming deadlines — always grouped by event_key (usually a
    // shared close date across many clients).
    const groupUpcoming = groupByEventKey(upcomingRaw);
    groupUpcoming.sort((a, b) => b.items.length - a.items.length);

    // Sort routine clients by number of items desc.
    const quickApprovals = Array.from(routineByClient.values())
      .sort((a, b) => b.items.length - a.items.length);

    return {
      judgment: groupJudgment,
      upcomingDeadlines: groupUpcoming,
      quickApprovals,
    };
  }, [today]);

  const chronicClients = useMemo(
    () => (health?.clients || []).filter((c) => !dismissedClients.has(c.company_id)),
    [health, dismissedClients]
  );

  const dismissClient = (cid) => {
    setDismissedClients((prev) => new Set(prev).add(cid));
  };

  // ── Bulk approve — loop signoff endpoints for every actionable
  // item in a client's routine group. Returns count actually signed.
  const approveClientGroup = async (group) => {
    setApproving((p) => new Set(p).add(group.company_id));
    let signed = 0;
    try {
      // Sort so pre-close checkpoints (recon/invoices/bills) sign
      // BEFORE the composite `closed` — backend gates closed on the
      // others being green.
      const order = { recon: 0, invoices: 1, bills: 2, txns_reviewed: 3, closed: 4 };
      const actionable = group.items
        .map((it) => ({ it, kind: extractCheckpointKind(it), ym: extractYm(it) }))
        .filter((x) => x.kind && x.ym)
        .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
      for (const { it, kind, ym } of actionable) {
        try {
          await api.post(
            `/companies/${group.company_id}/month-close/${ym}/checkpoint`,
            { kind, signed: true },
          );
          signed++;
        } catch (e) {
          // Continue even on individual failures — a 409 on `closed`
          // just means one of the preconditions was already
          // unfulfilled; the rest may still succeed.
          console.warn(`Skipped ${kind} for ${it.id}:`, e?.response?.data?.detail);
        }
      }
      toast.success(
        signed > 0
          ? `Approved ${signed}/${actionable.length} for ${group.company_name}`
          : `Nothing signable in ${group.company_name}`,
      );
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Bulk approve failed");
    } finally {
      setApproving((p) => {
        const n = new Set(p);
        n.delete(group.company_id);
        return n;
      });
    }
    return signed;
  };

  const approveAllTail = async (groups) => {
    setApproving((p) => new Set(p).add("__tail__"));
    let total = 0;
    for (const g of groups) {
      total += await approveClientGroup(g);
    }
    toast.success(`Approved ${total} items across ${groups.length} clients`);
    setApproving((p) => {
      const n = new Set(p);
      n.delete("__tail__");
      return n;
    });
  };

  const now = new Date();
  const greeting =
    now.getHours() < 12 ? "Good morning" :
    now.getHours() < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="p-6 max-w-[1280px] mx-auto" data-testid="cockpit-today-v2-page">
      {/* Refresh in top-right */}
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
          {routineTotal > 0 && (
            <span
              className="text-sm text-slate-400 ml-2"
              data-testid="cockpit-v2-routine-summary"
            >
              · {routineTotal} routine item{routineTotal === 1 ? "" : "s"} batched below
            </span>
          )}
        </div>
        {handledCount > 0 && (
          <div className="mt-2 text-xs text-slate-500 flex items-center gap-1.5" data-testid="cockpit-v2-handled-count">
            <CheckCircle2 size={11} className="text-emerald-500" />
            <span className="font-mono-num text-slate-700 font-semibold">{handledCount}</span>
            <span>handled overnight — see below</span>
          </div>
        )}
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

      {/* Needs your judgment */}
      {judgment.length > 0 ? (
        <section className="mb-8" data-testid="cockpit-v2-judgment">
          <div className="flex items-center gap-2 mb-2 text-slate-700">
            <Flag size={14} className="text-red-500" />
            <h2 className="text-sm font-semibold">
              Needs your judgment
            </h2>
            <span className="text-[11px] text-slate-400 font-normal ml-auto">
              {judgment.length} item{judgment.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {judgment.map((g) => (
              <JudgmentGroup key={g.event_key || g.items[0].id} group={g} nav={nav} />
            ))}
          </div>
        </section>
      ) : (
        <div className="mb-6 bg-white rounded-lg border border-emerald-200 p-6 text-center" data-testid="cockpit-v2-empty">
          <CheckCircle2 className="mx-auto text-emerald-500 mb-2" size={30} />
          <div className="text-base font-semibold text-slate-900">Nothing needs judgment.</div>
          <div className="text-xs text-slate-500 mt-1">
            Batch through the quick approvals below when you have a minute.
          </div>
        </div>
      )}

      {/* Upcoming deadlines — informational, not counted in decisions */}
      {upcomingDeadlines.length > 0 && (
        <section className="mb-8" data-testid="cockpit-v2-upcoming-deadlines">
          <div className="flex items-center gap-2 mb-2 text-slate-700">
            <Calendar size={14} className="text-slate-500" />
            <h2 className="text-sm font-semibold">
              Upcoming deadlines
            </h2>
            <span className="text-[11px] text-slate-400 font-normal ml-auto">
              {upcomingDeadlines.reduce((s, g) => s + g.items.length, 0)} across{" "}
              {upcomingDeadlines.length} event{upcomingDeadlines.length === 1 ? "" : "s"} · informational
            </span>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {upcomingDeadlines.map((g) => (
              <JudgmentGroup
                key={g.event_key || g.items[0].id}
                group={g}
                nav={nav}
                variant="upcoming"
              />
            ))}
          </div>
        </section>
      )}

      {/* Quick approvals */}
      {quickApprovals.length > 0 && (
        <QuickApprovals
          groups={quickApprovals}
          approving={approving}
          onApproveGroup={approveClientGroup}
          onApproveTail={approveAllTail}
          collapsed={collapsedTail}
          onToggleCollapsed={() => setCollapsedTail((v) => !v)}
        />
      )}

      {/* Handled overnight collapsed footer */}
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

      {/* AI activity by client — dropdown per company */}
      <AiUsageByClient />
    </div>
  );
}

// ── Judgment / Upcoming group ──────────────────────────────────────
// If the group has exactly one item, renders as a single row (same
// visual as before). If 2+ items share an event_key, renders as a
// collapsible header ("15 clients have month-end close due 2026-09-15
// ▸") that expands to per-client child rows, each with its own action.
function JudgmentGroup({ group, nav, variant = "judgment" }) {
  const [open, setOpen] = useState(false);
  const single = group.items.length === 1;
  const it = group.items[0];

  if (single) {
    return (
      <JudgmentRow item={it} onClick={() => nav(it.action_route)} variant={variant} />
    );
  }

  // Grouped — collapsible header row. The header aggregates by
  // client count; children are the underlying items, still with
  // their own action buttons.
  return (
    <div data-testid={`cockpit-v2-group-${group.event_key || "solo"}`}>
      <div
        onClick={() => setOpen((v) => !v)}
        className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 cursor-pointer"
      >
        {variant === "upcoming" ? (
          <span className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-300 shrink-0 inline-flex items-center gap-1">
            <Calendar size={10} />
            deadline
          </span>
        ) : (
          <RiskBadge bucket={group.risk_bucket} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-900 truncate">
            <span className="font-mono-num font-semibold">{group.items.length}</span>
            {" clients: "}
            <span className="text-slate-700">{group.title}</span>
          </div>
          {group.subtitle && (
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {group.subtitle}
            </div>
          )}
        </div>
        <button
          className="text-xs text-slate-500 hover:text-slate-800 shrink-0 inline-flex items-center gap-0.5"
          data-testid={`cockpit-v2-group-toggle-${group.event_key || "solo"}`}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Hide" : "Show all"}
        </button>
      </div>
      {open && (
        <div className="bg-slate-50/50 border-t border-slate-100 divide-y divide-slate-100">
          {group.items.map((child) => (
            <div
              key={child.id}
              onClick={() => nav(child.action_route)}
              className="pl-11 pr-4 py-2 flex items-center gap-3 hover:bg-white cursor-pointer"
              data-testid={`cockpit-v2-group-child-${child.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate">
                  {child.company_name}
                </div>
                {child.age_days > 0 && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    <Clock size={9} className="inline -mt-0.5 mr-0.5" />
                    {child.age_days}d
                  </div>
                )}
              </div>
              <button
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium shrink-0"
                data-testid={`cockpit-v2-group-child-action-${child.id}`}
              >
                {child.action_label} →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Needs-judgment single row ────────────────────────────────────────
function JudgmentRow({ item, onClick, variant = "judgment" }) {
  return (
    <div
      className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 cursor-pointer"
      onClick={onClick}
      data-testid={`cockpit-v2-judgment-row-${item.id}`}
    >
      {variant === "upcoming" ? (
        <span className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-300 shrink-0 inline-flex items-center gap-1">
          <Calendar size={10} />
          deadline
        </span>
      ) : (
        <RiskBadge bucket={item.risk_bucket} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-700">
            {item.company_name}
          </span>
          <span className="text-slate-300">·</span>
          <span className="text-sm text-slate-900 truncate">
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
        {item.subtitle && (
          <div className="text-xs text-slate-500 mt-0.5 truncate">
            {item.subtitle}
          </div>
        )}
      </div>
      <button
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium shrink-0 ml-2"
        data-testid={`cockpit-v2-action-${item.id}`}
      >
        {item.action_label} →
      </button>
    </div>
  );
}

// ── Quick Approvals — grouped by client ──────────────────────────────
function QuickApprovals({
  groups, approving, onApproveGroup, onApproveTail, collapsed, onToggleCollapsed,
}) {
  const VISIBLE_HEAD = 3;
  const head = groups.slice(0, VISIBLE_HEAD);
  const tail = groups.slice(VISIBLE_HEAD);
  const tailItemsTotal = tail.reduce((s, g) => s + g.items.length, 0);
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);
  const nav = useNavigate();

  return (
    <section data-testid="cockpit-v2-quick-approvals">
      <div className="flex items-center gap-2 mb-2 text-slate-700">
        <CheckCircle2 size={14} className="text-emerald-500" />
        <h2 className="text-sm font-semibold">
          Quick approvals
        </h2>
        <span className="text-[11px] text-slate-400 font-normal ml-auto">
          {totalItems} item{totalItems === 1 ? "" : "s"} · {groups.length} client{groups.length === 1 ? "" : "s"} · all auto-passed
        </span>
      </div>
      <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
        {head.map((g) => (
          <GroupRow
            key={g.company_id}
            group={g}
            busy={approving.has(g.company_id)}
            onApprove={() => onApproveGroup(g)}
            onExpand={() => nav(`/accounting/month-close?company=${g.company_id}`)}
          />
        ))}
        {tail.length > 0 && collapsed && (
          <div
            className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors"
            data-testid="cockpit-v2-tail-row"
          >
            <span className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              routine
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-800">
                {tail.length} more client{tail.length === 1 ? "" : "s"}, {tailItemsTotal} item{tailItemsTotal === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                All auto-passed, no anomalies
              </div>
            </div>
            <button
              onClick={onToggleCollapsed}
              className="text-xs text-slate-500 hover:text-slate-800"
              data-testid="cockpit-v2-tail-expand"
            >
              Show all
            </button>
            <button
              onClick={() => onApproveTail(tail)}
              disabled={approving.has("__tail__")}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
              data-testid="cockpit-v2-tail-approve"
            >
              {approving.has("__tail__") && <Loader2 size={11} className="animate-spin" />}
              Approve all {tailItemsTotal}
            </button>
          </div>
        )}
        {tail.length > 0 && !collapsed && tail.map((g) => (
          <GroupRow
            key={g.company_id}
            group={g}
            busy={approving.has(g.company_id)}
            onApprove={() => onApproveGroup(g)}
            onExpand={() => nav(`/accounting/month-close?company=${g.company_id}`)}
          />
        ))}
        {tail.length > 0 && !collapsed && (
          <div className="px-4 py-2 flex justify-end">
            <button
              onClick={onToggleCollapsed}
              className="text-xs text-slate-500 hover:text-slate-800"
              data-testid="cockpit-v2-tail-collapse"
            >
              Collapse tail
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function GroupRow({ group, busy, onApprove, onExpand }) {
  // What are we approving? Distill into a comma-separated summary
  // like "reconciliation, invoices, bills, close 2026-08" so the CPA
  // knows what's about to be signed with one click.
  const summary = useMemo(() => {
    const kinds = new Set();
    let ym = null;
    for (const it of group.items) {
      const k = extractCheckpointKind(it);
      if (k) kinds.add(k);
      if (!ym) ym = extractYm(it);
    }
    const labelMap = {
      recon: "reconciliation",
      invoices: "invoices",
      bills: "bills",
      txns_reviewed: "transactions",
      closed: ym ? `close ${ym}` : "close",
    };
    const bits = ["recon", "invoices", "bills", "txns_reviewed", "closed"]
      .filter((k) => kinds.has(k))
      .map((k) => labelMap[k]);
    return bits.length ? bits.join(", ") : group.items.map((i) => i.title).join(", ");
  }, [group]);

  return (
    <div
      className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors"
      data-testid={`cockpit-v2-group-${group.company_id}`}
    >
      <span className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
        routine
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-900 truncate">
          {group.company_name}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 truncate">
          {group.items.length} item{group.items.length === 1 ? "" : "s"} ready · {summary}
        </div>
      </div>
      <button
        onClick={onExpand}
        className="text-xs text-slate-400 hover:text-slate-700"
        data-testid={`cockpit-v2-group-expand-${group.company_id}`}
        title="Open month-close for this client"
      >
        expand
      </button>
      <button
        onClick={onApprove}
        disabled={busy}
        className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
        data-testid={`cockpit-v2-group-approve-${group.company_id}`}
      >
        {busy && <Loader2 size={11} className="animate-spin" />}
        Approve all {group.items.length}
      </button>
    </div>
  );
}

// ── Risk badge (leading each judgment row) ───────────────────────────
function RiskBadge({ bucket }) {
  if (bucket === "high_risk") {
    return (
      <span
        className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 shrink-0 inline-flex items-center gap-1"
        data-testid="risk-badge-high-risk"
      >
        <Flame size={10} />
        high risk
      </span>
    );
  }
  return (
    <span
      className="text-[10px] font-mono-num uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 shrink-0 inline-flex items-center gap-1"
      data-testid="risk-badge-flagged"
    >
      <Flag size={10} />
      flagged
    </span>
  );
}

// ── Confidence badge — 3 tiers ───────────────────────────────────────
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


// ── AI Activity by Client (bottom strip) ───────────────────────────
// Dropdown per company showing which of the 41 AI systems fired in
// the selected window (last-24h or a calendar month). Reads from
// GET /api/cockpit/ai-usage-by-company.
function AiUsageByClient() {
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [scope, setScope] = useState("monthly");   // "monthly" | "24h"
  const [month, setMonth] = useState(currentYm);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openIds, setOpenIds] = useState(() => new Set());

  const isCurrentMonth = month === currentYm;

  const load = async () => {
    setBusy(true);
    try {
      const params = { scope };
      if (scope === "monthly") params.month = month;
      const r = await api.get(`/cockpit/ai-usage-by-company`, { params });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load AI activity");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope, month]);

  const shiftMonth = (delta) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };

  const toggleCompany = (cid) => {
    setOpenIds((prev) => {
      const n = new Set(prev);
      if (n.has(cid)) n.delete(cid);
      else n.add(cid);
      return n;
    });
  };

  const monthLabel = (() => {
    if (scope === "24h") return "";
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
      month: "long", year: "numeric", timeZone: "UTC",
    });
  })();

  const companies = data?.companies || [];
  const totalUses = companies.reduce((s, c) => s + (c.total_uses || 0), 0);

  return (
    <section
      className="mt-8 pt-6 border-t border-slate-200"
      data-testid="cockpit-v2-ai-usage-section"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Bot size={14} className="text-indigo-500" />
        <h2 className="text-sm font-semibold text-slate-700">
          AI activity by client
        </h2>
        <span className="text-[11px] text-slate-400">
          {busy ? "loading…" :
            companies.length === 0 ? "no activity in this window" :
            `${totalUses} use${totalUses === 1 ? "" : "s"} across ${companies.length} client${companies.length === 1 ? "" : "s"}`}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Scope toggle */}
          <div
            className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs"
            data-testid="ai-usage-scope-toggle"
          >
            <button
              onClick={() => setScope("monthly")}
              className={`px-2.5 py-1 ${scope === "monthly" ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid="ai-usage-scope-monthly"
            >
              Monthly
            </button>
            <button
              onClick={() => setScope("24h")}
              className={`px-2.5 py-1 border-l border-slate-300 ${scope === "24h" ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid="ai-usage-scope-24h"
            >
              Last 24h
            </button>
          </div>

          {/* Month navigator */}
          {scope === "monthly" && (
            <div className="inline-flex items-center gap-1" data-testid="ai-usage-month-nav">
              <button
                onClick={() => shiftMonth(-1)}
                className="p-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-600"
                title="Previous month"
                data-testid="ai-usage-month-prev"
              >
                <ChevronLeft size={12} />
              </button>
              <span
                className="text-xs font-medium text-slate-700 min-w-[110px] text-center px-2"
                data-testid="ai-usage-month-label"
              >
                {monthLabel}
                {isCurrentMonth && <span className="ml-1 text-[10px] text-emerald-600 font-normal">· current</span>}
              </span>
              <button
                onClick={() => shiftMonth(1)}
                disabled={isCurrentMonth}
                className="p-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title={isCurrentMonth ? "Already at current month" : "Next month"}
                data-testid="ai-usage-month-next"
              >
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Companies list */}
      <div
        className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100"
        data-testid="ai-usage-companies-list"
      >
        {busy && companies.length === 0 && (
          <div className="px-4 py-6 text-sm text-slate-400 flex items-center justify-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        )}
        {!busy && companies.length === 0 && (
          <div className="px-4 py-6 text-sm text-slate-500 text-center">
            No AI activity recorded in this window.
          </div>
        )}
        {companies.map((c) => {
          const open = openIds.has(c.company_id);
          return (
            <div key={c.company_id} data-testid={`ai-usage-company-${c.company_id}`}>
              <button
                onClick={() => toggleCompany(c.company_id)}
                className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 text-left"
                data-testid={`ai-usage-company-toggle-${c.company_id}`}
              >
                {open ? (
                  <ChevronDown size={13} className="text-slate-400 shrink-0" />
                ) : (
                  <ChevronRight size={13} className="text-slate-400 shrink-0" />
                )}
                <span className="text-sm font-medium text-slate-800 flex-1 truncate">
                  {c.company_name}
                </span>
                <span className="text-[11px] text-slate-500 shrink-0">
                  <span className="font-mono-num text-slate-700 font-semibold">{c.total_uses}</span>
                  {" "}use{c.total_uses === 1 ? "" : "s"}
                  {" · "}
                  {c.systems.length} system{c.systems.length === 1 ? "" : "s"}
                </span>
              </button>
              {open && (
                <div
                  className="bg-slate-50/60 border-t border-slate-100"
                  data-testid={`ai-usage-company-systems-${c.company_id}`}
                >
                  {c.systems.map((s) => (
                    <AiUsageSystemRow
                      key={s.key}
                      companyId={c.company_id}
                      system={s}
                      scope={scope}
                      month={scope === "monthly" ? month : null}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}



// One expandable row inside the AI-activity-per-company panel. Lazy-loads
// individual events/runs on first open so we don't hammer the backend
// when the parent company is expanded but the user doesn't drill in.
function AiUsageSystemRow({ companyId, system, scope, month }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const params = { company_id: companyId, system_key: system.key, scope };
      if (scope === "monthly" && month) params.month = month;
      const r = await api.get(`/cockpit/ai-usage-detail`, { params });
      setItems(r.data?.items || []);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load activity");
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items === null && !busy) load();
  };

  const fmtTs = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch { return iso; }
  };

  const gotoAgentRun = (item) => {
    const p = new URLSearchParams();
    p.set("tab", "findings");
    p.set("template_key", system.key.replace(/^agent:/, ""));
    if (item.agent_id) p.set("agent_id", item.agent_id);
    navigate(`/cockpit/agents?${p.toString()}`);
  };

  return (
    <div
      className="border-b border-slate-100 last:border-b-0"
      data-testid={`ai-usage-system-${companyId}-${system.key}`}
    >
      <button
        onClick={toggle}
        className="w-full px-4 pl-10 py-1.5 flex items-center gap-2 text-sm hover:bg-slate-100/60 text-left"
        data-testid={`ai-usage-system-toggle-${companyId}-${system.key}`}
      >
        {open ? (
          <ChevronDown size={11} className="text-slate-400 shrink-0" />
        ) : (
          <ChevronRight size={11} className="text-slate-400 shrink-0" />
        )}
        <Sparkles
          size={10}
          className={system.category === "agent" ? "text-indigo-500 shrink-0" : "text-emerald-500 shrink-0"}
        />
        <span className="text-slate-700 flex-1 truncate">{system.label}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-mono-num ${
            system.category === "agent"
              ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
              : "bg-emerald-50 text-emerald-700 border border-emerald-200"
          }`}
          title={system.category === "agent" ? "Scheduled/manual agent run" : "AI system invocation"}
        >
          {system.category}
        </span>
        <span
          className="text-[11px] font-mono-num text-slate-800 font-semibold min-w-[36px] text-right"
          data-testid={`ai-usage-count-${companyId}-${system.key}`}
        >
          {system.count > 1 ? `×${system.count}` : "×1"}
        </span>
      </button>

      {open && (
        <div
          className="pl-16 pr-4 pb-2 pt-1 bg-white/60"
          data-testid={`ai-usage-system-detail-${companyId}-${system.key}`}
        >
          {busy && (
            <div className="text-[11px] text-slate-400 flex items-center gap-1 py-1">
              <Loader2 size={10} className="animate-spin" /> Loading…
            </div>
          )}
          {!busy && error && (
            <div className="text-[11px] text-red-600 py-1">{error}</div>
          )}
          {!busy && !error && items && items.length === 0 && (
            <div className="text-[11px] text-slate-400 py-1">
              No individual events recorded.
            </div>
          )}
          {!busy && !error && items && items.length > 0 && (
            <ul
              className="divide-y divide-slate-100"
              data-testid={`ai-usage-system-items-${companyId}-${system.key}`}
            >
              {items.map((it) => (
                <li
                  key={it.id}
                  className="py-1 flex items-center gap-3 text-[11px] text-slate-600"
                  data-testid={`ai-usage-system-item-${it.id}`}
                >
                  <span className="font-mono-num text-slate-500 min-w-[110px]">
                    {fmtTs(it.ts)}
                  </span>
                  {it.kind === "agent_run" ? (
                    <>
                      <span
                        className={`text-[9px] px-1 py-0.5 rounded uppercase font-semibold tracking-wider ${
                          it.status === "success" ? "bg-emerald-50 text-emerald-700" :
                          it.status === "error"   ? "bg-red-50 text-red-700" :
                          "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {it.status}
                      </span>
                      <span className="text-slate-700 flex-1 truncate">
                        {it.findings_count > 0
                          ? `${it.findings_count} finding${it.findings_count === 1 ? "" : "s"}`
                          : it.error ? `Error: ${String(it.error).slice(0, 80)}` : "No findings"}
                      </span>
                      <span
                        className="text-slate-400 truncate max-w-[140px]"
                        title={it.triggered_by}
                      >
                        {it.triggered_by?.startsWith("manual:") ? "manual" :
                         it.triggered_by?.startsWith("schedule") ? "scheduled" :
                         it.triggered_by || ""}
                      </span>
                      {it.findings_count > 0 && (
                        <button
                          onClick={() => gotoAgentRun(it)}
                          className="text-indigo-600 hover:text-indigo-700 hover:underline shrink-0"
                          data-testid={`ai-usage-agent-view-${it.id}`}
                        >
                          View
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span
                        className="text-slate-500 shrink-0 font-mono-num"
                        title={it.provider}
                      >
                        {it.model || it.service || "—"}
                      </span>
                      <span className="text-slate-500 flex-1 truncate font-mono-num">
                        {it.total_tokens ? `${it.total_tokens.toLocaleString()} tok` : ""}
                      </span>
                      <span className="text-slate-400 font-mono-num shrink-0">
                        {it.cost_cents ? `¢${it.cost_cents.toFixed(2)}` : ""}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
