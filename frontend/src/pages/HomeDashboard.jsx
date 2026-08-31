import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Loader2, ArrowRight, TrendingUp, TrendingDown, Users, GitBranch,
  Briefcase, Calculator, Sparkles, Clock, StickyNote, Phone, Mail,
  CalendarCheck, ClipboardCheck, DollarSign, Building2, ChevronRight,
  Pin, PinOff, EyeOff, GripVertical, Plus, Settings2, RotateCcw, Check,
  X, Star, Library, Wand2, Trash2, Maximize2, Minimize2,
  Landmark, PiggyBank, Timer, Users2, FileText as FileWarning,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { NotifRow } from "@/components/NotificationBell";
import { InstallRibbon } from "@/components/InstallPrompt";

/**
 * HomeDashboard — /home (Phase D-2, Feb 2026).
 *
 * Customizable, drag-reorderable dashboard.
 *
 * Data model:
 *   - GET /home-summary       → the CATALOG of every widget the
 *                                platform can render for this company.
 *   - GET /dashboard-layout   → the user's personal order/pin/hide
 *                                overlay for that catalog.
 *
 * We merge them client-side so:
 *   1) Pinned widgets sit at the top in the user's chosen order.
 *   2) Unpinned + visible widgets follow in the user's chosen order.
 *   3) Brand-new catalog widgets (added since the user last saved
 *      a layout) get appended at the end so features never go
 *      missing after a platform upgrade.
 *
 * Toggle "Customize" to reveal grip / pin / hide affordances +
 * an Add-widget tray sourced from the catalog's hidden set.
 */
export default function HomeDashboard() {
  const { currentId, current } = useCompany();
  const currentName = current?.name;
  const fmt = useMoneyFmt();
  const [catalog, setCatalog] = useState(null);   // /home-summary
  const [layout, setLayout] = useState(null);      // /dashboard-layout
  const [loading, setLoading] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [showAddTray, setShowAddTray] = useState(false);
  const [showKpiBuilder, setShowKpiBuilder] = useState(false);

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [cat, lay] = await Promise.all([
        api.get(`/companies/${currentId}/home-summary`),
        api.get(`/companies/${currentId}/dashboard-layout`),
      ]);
      setCatalog(cat.data);
      setLayout(lay.data?.widgets || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [currentId]);
  useEffect(() => { load(); }, [load]);

  // ---- Merge catalog + layout into an ordered, decorated render list ----
  const decorated = useMemo(() => {
    if (!catalog) return {};
    const byId = new Map(catalog.widgets.map(w => [w.id, w]));
    const layoutIds = new Set(layout?.map(l => l.id) || []);
    // Widgets in the user's layout, in that order.
    const ordered = (layout || [])
      .filter(l => byId.has(l.id))
      .map(l => ({ ...byId.get(l.id),
                    pinned: l.pinned, hidden: l.hidden,
                    w: l.w ?? DEFAULT_W[byId.get(l.id).kind] ?? 1 }));
    // Any catalog widgets NOT yet in the user's layout — append at end.
    // Respect the catalog's `default_hidden` flag so brand-new
    // library widgets don't invade a clean dashboard on first load.
    for (const w of catalog.widgets) {
      if (!layoutIds.has(w.id)) {
        ordered.push({ ...w,
                        pinned: false,
                        hidden: !!w.default_hidden,
                        w: DEFAULT_W[w.kind] ?? 1 });
      }
    }
    // Split into pinned → unpinned. Hidden are pulled out completely
    // and surfaced only in the "+ Add widget" tray.
    const pinned = ordered.filter(w => w.pinned && !w.hidden);
    const unpinned = ordered.filter(w => !w.pinned && !w.hidden);
    const hidden = ordered.filter(w => w.hidden);
    return { pinned, unpinned, hidden, all: [...pinned, ...unpinned] };
  }, [catalog, layout]);

  // ---- Save helper: convert current render order into layout doc. ----
  const save = useCallback(async (nextLayout) => {
    if (!currentId) return;
    setLayout(nextLayout);
    try {
      await api.patch(`/companies/${currentId}/dashboard-layout`,
        { widgets: nextLayout });
    } catch (e) {
      toast.error(`Save failed: ${e.response?.data?.detail || e.message}`);
    }
  }, [currentId]);

  // ---- Layout mutations (single source of truth) ----
  // Serialize the CURRENT merged view back into a canonical layout
  // list so save() gets everything (pinned + unpinned + hidden).
  const toCanonical = useCallback((next) => {
    // next = merged {pinned, unpinned, hidden} arrays
    return [
      ...next.pinned.map(w   => ({ id: w.id, pinned: true,  hidden: false, w: w.w })),
      ...next.unpinned.map(w => ({ id: w.id, pinned: false, hidden: false, w: w.w })),
      ...next.hidden.map(w   => ({ id: w.id, pinned: false, hidden: true,  w: w.w })),
    ];
  }, []);

  // Cycle column span: 1 → 2 → 4 → 1
  const cycleWidth = (widgetId) => {
    const cur = decorated;
    const bumpIn = (arr) => arr.map(w => w.id === widgetId
        ? { ...w, w: NEXT_W[w.w ?? DEFAULT_W[w.kind] ?? 1] } : w);
    save(toCanonical({
      pinned:   bumpIn(cur.pinned),
      unpinned: bumpIn(cur.unpinned),
      hidden:   cur.hidden,
    }));
  };

  const togglePin = (widgetId) => {
    const cur = decorated;
    const item = [...cur.pinned, ...cur.unpinned, ...cur.hidden]
                    .find(w => w.id === widgetId);
    if (!item) return;
    const next = {
      pinned:   cur.pinned.filter(w => w.id !== widgetId),
      unpinned: cur.unpinned.filter(w => w.id !== widgetId),
      hidden:   cur.hidden.filter(w => w.id !== widgetId),
    };
    if (item.pinned) {
      next.unpinned = [{ ...item, pinned: false }, ...next.unpinned];
    } else {
      next.pinned = [...next.pinned, { ...item, pinned: true }];
    }
    save(toCanonical(next));
  };

  const hideWidget = (widgetId) => {
    const cur = decorated;
    const item = [...cur.pinned, ...cur.unpinned]
                    .find(w => w.id === widgetId);
    if (!item) return;
    const next = {
      pinned:   cur.pinned.filter(w => w.id !== widgetId),
      unpinned: cur.unpinned.filter(w => w.id !== widgetId),
      hidden:   [{ ...item, hidden: true }, ...cur.hidden],
    };
    save(toCanonical(next));
  };

  const showWidget = (widgetId) => {
    const cur = decorated;
    const item = cur.hidden.find(w => w.id === widgetId);
    if (!item) return;
    const next = {
      pinned:   cur.pinned,
      unpinned: [...cur.unpinned, { ...item, hidden: false }],
      hidden:   cur.hidden.filter(w => w.id !== widgetId),
    };
    save(toCanonical(next));
  };

  const resetLayout = () => save([]);

  // ---- HTML5 DnD wiring ----
  const onDragStart = (id) => (e) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires setData to actually initiate the drag.
    try { e.dataTransfer.setData("text/plain", id); } catch { /* noop */ }
  };
  const onDragOver = (id) => (e) => {
    e.preventDefault();
    if (id !== dragOverId) setDragOverId(id);
  };
  const onDrop = (targetId) => (e) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) {
      setDragId(null); setDragOverId(null); return;
    }
    // Reorder inside the same section only (pinned or unpinned).
    const cur = decorated;
    const src = cur.pinned.find(w => w.id === dragId) ? "pinned"
              : cur.unpinned.find(w => w.id === dragId) ? "unpinned" : null;
    const tgt = cur.pinned.find(w => w.id === targetId) ? "pinned"
              : cur.unpinned.find(w => w.id === targetId) ? "unpinned" : null;
    if (!src || !tgt) {
      setDragId(null); setDragOverId(null); return;
    }
    // Cross-section drop = also promote/demote pin.
    const draggedItem = cur[src].find(w => w.id === dragId);
    const nextSrc  = cur[src].filter(w => w.id !== dragId);
    const nextTgt  = (src === tgt ? nextSrc : cur[tgt]).slice();
    const insertAt = nextTgt.findIndex(w => w.id === targetId);
    nextTgt.splice(insertAt < 0 ? nextTgt.length : insertAt, 0,
                    { ...draggedItem, pinned: (tgt === "pinned") });
    const next = {
      pinned:   tgt === "pinned"  ? nextTgt : (src === "pinned"  ? nextSrc : cur.pinned),
      unpinned: tgt === "unpinned"? nextTgt : (src === "unpinned"? nextSrc : cur.unpinned),
      hidden:   cur.hidden,
    };
    save(toCanonical(next));
    setDragId(null); setDragOverId(null);
  };

  // All visible widgets flow into a single 4-column grid; each
  // widget's `w` field determines how many columns it spans (1–4).
  // Activity defaults to full-width (w=4) so it doesn't fight for
  // space with dense KPI cards.

  const dndCtx = {
    customizing, dragId, dragOverId,
    onDragStart, onDragOver, onDrop,
    onPin: togglePin, onHide: hideWidget,
    onCycleWidth: cycleWidth,
    onDeleteCustom: async (kpiId) => {
      if (!window.confirm("Delete this KPI? This can't be undone.")) return;
      try {
        await api.delete(`/companies/${currentId}/custom-kpis/${kpiId}`);
        toast.success("KPI deleted");
        await load();
      } catch (e) {
        toast.error(`Delete failed: ${e.response?.data?.detail || e.message}`);
      }
    },
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="home-dashboard">
      {/* Mobile-only install nudge — auto-hides once dismissed for
          14 days, once the app is installed, or on non-mobile. */}
      <InstallRibbon />

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
            {loading ? "Refreshing…"
              : customizing
                ? "Drag to reorder · Click ⤢ to resize · ⭐ Pin · 👁 Hide"
                : "Everything across Accounting · CRM · Projects · Team"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {customizing && (
            <button onClick={() => setShowKpiBuilder(true)}
                    data-testid="home-ai-kpi-btn"
                    className="text-sm px-3 py-1.5 rounded-md border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-violet-50 text-fuchsia-800 font-medium hover:from-fuchsia-100 hover:to-violet-100 inline-flex items-center gap-1.5">
              <Wand2 size={13} /> Ask AI for a KPI
            </button>
          )}
          {customizing && decorated.hidden?.length > 0 && (
            <div className="relative">
              <button onClick={() => setShowAddTray(v => !v)}
                      data-testid="home-add-widget"
                      className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5">
                <Library size={13} /> Widget library ({decorated.hidden.length})
              </button>
              {showAddTray && (
                <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg z-20"
                     data-testid="home-add-widget-tray">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 px-3 pt-2 pb-1">
                    Available widgets
                  </div>
                  <ul className="max-h-72 overflow-y-auto py-1">
                    {decorated.hidden.map(w => {
                      const Icon = LIBRARY_ICONS[w.id] || Sparkles;
                      return (
                        <li key={w.id}>
                          <button onClick={() => { showWidget(w.id); setShowAddTray(false); }}
                                  data-testid={`home-add-widget-${w.id}`}
                                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-start gap-2 text-slate-700">
                            <Icon size={13} className="text-violet-500 shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{w.label || w.id}</div>
                              {w.sub && (
                                <div className="text-[10px] text-slate-400 truncate">{w.sub}</div>
                              )}
                            </div>
                            <Plus size={11} className="text-emerald-600 shrink-0 mt-0.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
          {customizing && (layout?.length || 0) > 0 && (
            <button onClick={resetLayout}
                    data-testid="home-reset-layout"
                    title="Reset to platform default"
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RotateCcw size={13} /> Reset
            </button>
          )}
          <button onClick={() => setCustomizing(v => !v)}
                  data-testid="home-customize-toggle"
                  className={`text-sm px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5 ${
                    customizing
                      ? "bg-slate-900 text-white hover:bg-slate-800"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}>
            {customizing ? <><Check size={13} /> Done</> : <><Settings2 size={13} /> Customize</>}
          </button>
          <button onClick={() => window.dispatchEvent(new Event("insights:open"))}
                  data-testid="home-ask-ai"
                  className="text-sm px-3 py-1.5 rounded-md border border-indigo-200 bg-gradient-to-br from-indigo-50 to-fuchsia-50 text-indigo-900 font-medium hover:from-indigo-100 hover:to-fuchsia-100 inline-flex items-center gap-1.5">
            <Sparkles size={13} /> Ask AI
          </button>
        </div>
      </div>

      {loading && !catalog && (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 size={24} className="animate-spin" />
        </div>
      )}

      {catalog && (
        <>
          {/* Pinned strip — full 4-col grid so pinned widgets can also
              respect their own `w`. */}
          {decorated.pinned.length > 0 && (
            <section data-testid="home-pinned-section" className="space-y-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-amber-600 font-semibold">
                <Star size={11} className="fill-amber-500 text-amber-500" />
                Pinned
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {decorated.pinned.map(w => (
                  <div key={w.id} className={SPAN_CLS[clampSpan(w.w)]}>
                    <WidgetShell widget={w} ctx={dndCtx} fmt={fmt} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Everything else — one big 4-col grid, ordered exactly as
              the user's layout says. Widgets pick their own col-span. */}
          {decorated.unpinned?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
                  data-testid="home-widgets-grid">
              {decorated.unpinned.map(w => (
                <div key={w.id} className={SPAN_CLS[clampSpan(w.w)]}>
                  <WidgetShell widget={w} ctx={dndCtx} fmt={fmt} />
                </div>
              ))}
            </div>
          )}

          {(!decorated.pinned?.length && !decorated.unpinned?.length) && (
            <div className="text-center py-16 rounded-xl border border-dashed border-slate-200 bg-slate-50">
              <p className="text-sm text-slate-500 mb-2">
                Your dashboard is empty.
              </p>
              <button onClick={resetLayout}
                      className="text-xs text-violet-600 hover:underline">
                Restore default layout
              </button>
            </div>
          )}
        </>
      )}

      {showKpiBuilder && (
        <AiKpiBuilderModal
          companyId={currentId}
          onClose={() => setShowKpiBuilder(false)}
          onSaved={() => { setShowKpiBuilder(false); load(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// WidgetShell — wraps every widget with the customize affordances
// ============================================================
function WidgetShell({ widget, ctx, fmt }) {
  const { customizing, dragId, dragOverId,
           onDragStart, onDragOver, onDrop, onPin, onHide,
           onCycleWidth, onDeleteCustom } = ctx;
  const isDragged = dragId === widget.id;
  const isTarget  = dragOverId === widget.id && dragId && dragId !== widget.id;
  const isCustom  = widget.custom === true;
  return (
    <div
      draggable={customizing}
      onDragStart={customizing ? onDragStart(widget.id) : undefined}
      onDragOver={customizing ? onDragOver(widget.id) : undefined}
      onDrop={customizing ? onDrop(widget.id) : undefined}
      onDragEnd={() => { /* handled by parent state clear on drop */ }}
      data-testid={`home-widget-${widget.id}`}
      className={`relative h-full ${customizing ? "cursor-grab active:cursor-grabbing" : ""} ${
        isDragged ? "opacity-40" : ""
      } ${isTarget ? "ring-2 ring-violet-400 ring-offset-2 rounded-xl" : ""} transition`}
    >
      {customizing && (
        <div className="absolute -top-2 -right-2 flex items-center gap-1 z-10">
          <button onClick={(e) => { e.stopPropagation(); onCycleWidth(widget.id); }}
                  title={`Resize (currently ${clampSpan(widget.w)}/4)`}
                  data-testid={`home-widget-resize-${widget.id}`}
                  className="w-6 h-6 rounded-full border bg-white text-slate-500 border-slate-200 hover:text-violet-600 hover:border-violet-300 shadow-sm flex items-center justify-center">
            <Maximize2 size={11} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onPin(widget.id); }}
                  title={widget.pinned ? "Unpin" : "Pin to top"}
                  data-testid={`home-widget-pin-${widget.id}`}
                  className={`w-6 h-6 rounded-full border shadow-sm flex items-center justify-center ${
                    widget.pinned
                      ? "bg-amber-500 text-white border-amber-600 hover:bg-amber-600"
                      : "bg-white text-slate-500 border-slate-200 hover:text-amber-600 hover:border-amber-300"
                  }`}>
            {widget.pinned ? <PinOff size={11} /> : <Pin size={11} />}
          </button>
          <button onClick={(e) => { e.stopPropagation(); onHide(widget.id); }}
                  title="Hide from dashboard"
                  data-testid={`home-widget-hide-${widget.id}`}
                  className="w-6 h-6 rounded-full border bg-white text-slate-500 border-slate-200 hover:text-rose-600 hover:border-rose-300 shadow-sm flex items-center justify-center">
            <EyeOff size={11} />
          </button>
          {isCustom && (
            <button onClick={(e) => { e.stopPropagation(); onDeleteCustom(widget.custom_kpi_id); }}
                    title="Delete this AI-generated KPI"
                    data-testid={`home-widget-delete-${widget.id}`}
                    className="w-6 h-6 rounded-full border bg-white text-slate-500 border-slate-200 hover:text-rose-700 hover:border-rose-400 shadow-sm flex items-center justify-center">
              <Trash2 size={11} />
            </button>
          )}
        </div>
      )}
      {customizing && (
        <div className="absolute top-2 left-2 z-10 text-slate-300">
          <GripVertical size={14} />
        </div>
      )}
      {isCustom && !customizing && (
        <div className="absolute top-2 right-2 z-10">
          <span className="text-[9px] uppercase tracking-widest bg-fuchsia-100 text-fuchsia-700 rounded px-1.5 py-0.5 font-semibold inline-flex items-center gap-0.5">
            <Wand2 size={8} /> AI
          </span>
        </div>
      )}
      <WidgetBody widget={widget} fmt={fmt} customizing={customizing} />
    </div>
  );
}

function WidgetBody({ widget, fmt, customizing }) {
  if (widget.kind === "kpi")           return <KpiCard widget={widget} fmt={fmt} />;
  if (widget.kind === "donut")         return <DonutCard widget={widget} />;
  if (widget.kind === "module")        return <ModuleCard widget={widget} fmt={fmt} disabled={customizing} />;
  if (widget.kind === "list")          return <ListWidget widget={widget} fmt={fmt} />;
  if (widget.kind === "activity")      return <ActivityCard widget={widget} />;
  if (widget.kind === "notifications") return <NotificationsWidget widget={widget} />;
  return null;
}

function NotificationsWidget({ widget }) {
  const items = widget.items || [];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full flex flex-col"
              data-testid="home-notifications-widget">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide">
          {widget.label}
          {items.length > 0 && (
            <span className="ml-2 text-[10px] font-semibold bg-rose-100 text-rose-700 rounded-full px-1.5 py-0.5 tabular-nums">
              {items.length}
            </span>
          )}
        </h2>
        <span className="text-[11px] text-slate-400">bell in the top-right too</span>
      </div>
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-400 italic py-8">
          Nothing to nudge you about.
        </div>
      ) : (
        <ol className="divide-y divide-slate-100 -mx-2 px-2">
          {items.slice(0, 6).map(n => (
            <NotifRow key={n.id} n={n} compact
                        onMark={async () => {
                          try { await api.post(`/notifications/${n.id}/read`); } catch { /* silent */ }
                        }} />
          ))}
        </ol>
      )}
    </section>
  );
}

// ============================================================
// Widget renderers (unchanged from Phase D-1 aside from disabled link)
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
  const Icon = KPI_ICONS[widget.id] || LIBRARY_ICONS[widget.id] || TrendingUp;
  let val;
  if (widget.value_kind === "currency") val = fmt(widget.value);
  else if (widget.value_kind === "percent") val = `${widget.value ?? 0}%`;
  else if (widget.value_kind === "text") val = widget.value;
  else val = widget.value;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 h-full">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold truncate">
            {widget.label}
          </div>
          <div className="mt-2 font-heading text-2xl font-bold text-slate-900 tabular-nums">
            {val}
          </div>
          {widget.sub && (
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">{widget.sub}</div>
          )}
        </div>
        <div className={`w-8 h-8 rounded-md ${tone.bg} ${tone.text} flex items-center justify-center shrink-0`}>
          <Icon size={14} />
        </div>
      </div>
    </div>
  );
}

function DonutCard({ widget }) {
  const pct = Math.max(0, Math.min(100, widget.percent || 0));
  const R = 40, C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 h-full">
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

function ModuleCard({ widget, fmt, disabled }) {
  const tone = TONE[widget.tone] || TONE.slate;
  const Icon = MODULE_ICONS[widget.id] || TrendingUp;
  const up = (widget.trend_hint || "").startsWith("+");
  const TrendIcon = up ? TrendingUp : TrendingDown;
  const trendCls = up ? "text-emerald-600" : "text-slate-500";
  const inner = (
    <>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-7 h-7 rounded-md ${tone.bg} ${tone.text} flex items-center justify-center`}>
          <Icon size={13} />
        </div>
        <h3 className="font-heading text-sm font-bold text-slate-900">
          {widget.label}
        </h3>
        {!disabled && (
          <ChevronRight size={12}
            className="ml-auto text-slate-300 group-hover:text-slate-600 group-hover:translate-x-0.5 transition-transform" />
        )}
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
      {!disabled && (
        <div className={`mt-2 text-[11px] ${tone.text} inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition`}>
          View dashboard <ArrowRight size={11} />
        </div>
      )}
    </>
  );
  const cls = "rounded-xl border border-slate-200 bg-white p-4 h-full block group";
  if (disabled) {
    // In customize mode we neutralize the link so drag doesn't
    // accidentally navigate the user out of the page.
    return <div className={cls}>{inner}</div>;
  }
  return (
    <Link to={widget.link}
          className={`${cls} hover:border-slate-300 hover:shadow-sm transition`}>
      {inner}
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
    <section className="rounded-xl border border-slate-200 bg-white p-4">
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
                  className="flex items-start gap-3 py-2">
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
// List widget — used for Top Customers, Overdue Invoices, and any
// AI-generated list-shape KPI. Renders label + right-aligned value
// + optional sub-caption.
// ============================================================
function ListWidget({ widget, fmt }) {
  const tone = TONE[widget.tone] || TONE.slate;
  const items = widget.items || [];
  const Icon = LIBRARY_ICONS[widget.id] || Library;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-7 h-7 rounded-md ${tone.bg} ${tone.text} flex items-center justify-center`}>
          <Icon size={13} />
        </div>
        <h2 className="font-heading text-sm font-bold text-slate-900 uppercase tracking-wide truncate">
          {widget.label}
        </h2>
      </div>
      {items.length === 0 ? (
        <div className="text-center text-xs text-slate-400 italic py-6">
          {widget.empty_label || "Nothing here yet."}
        </div>
      ) : (
        <ol className="divide-y divide-slate-100 flex-1">
          {items.map(item => (
            <li key={item.id}
                className="flex items-center gap-2 py-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot} shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-900 truncate">{item.label}</div>
                {item.sub && (
                  <div className="text-[11px] text-slate-500 truncate">{item.sub}</div>
                )}
              </div>
              <div className="text-sm font-semibold text-slate-900 tabular-nums shrink-0">
                {widget.value_kind === "currency" ? fmt(item.value)
                  : widget.value_kind === "percent" ? `${item.value}%`
                  : item.value}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ============================================================
// AI KPI Builder Modal — natural language → validated Mongo agg
// ============================================================
function AiKpiBuilderModal({ companyId, onClose, onSaved }) {
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState("user");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(null);
  const [previewValue, setPreviewValue] = useState(null);
  const [error, setError] = useState(null);

  const examples = [
    "% of deals closed within 30 days of first contact",
    "Total invoices overdue by more than 60 days",
    "Average deal size for the Won stage",
    "Count of tasks completed this week",
    "Sum of expenses in the last 7 days",
  ];

  const generate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true); setError(null);
    try {
      const r = await api.post(
        `/companies/${companyId}/custom-kpis/generate`,
        { prompt: prompt.trim() });
      setDraft(r.data.draft);
      setPreviewValue(r.data.preview_value);
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    } finally { setGenerating(false); }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/custom-kpis`, {
        ...draft, scope, prompt: prompt.trim(),
      });
      toast.success(`KPI "${draft.name}" saved`);
      onSaved?.();
    } catch (e) {
      toast.error(`Save failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center px-4"
          role="dialog" aria-modal="true"
          data-testid="home-ai-kpi-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b bg-gradient-to-br from-fuchsia-50 to-violet-50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-white shadow-sm flex items-center justify-center text-fuchsia-700">
              <Wand2 size={14} />
            </div>
            <div>
              <div className="font-heading font-bold text-slate-900">Ask AI for a KPI</div>
              <div className="text-[11px] text-slate-500">
                Claude will draft a Mongo aggregation for you to preview + save
              </div>
            </div>
          </div>
          <button onClick={onClose}
                  className="p-1 rounded hover:bg-white/60 text-slate-400">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1 block">
              Describe the KPI in plain English
            </label>
            <textarea value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        placeholder="e.g. % of deals closed within 30 days of first contact"
                        data-testid="home-ai-kpi-prompt"
                        maxLength={500}
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            <div className="text-[10px] text-slate-400 mt-0.5 flex justify-between">
              <span>Max 500 chars</span>
              <span>{prompt.length}/500</span>
            </div>
          </div>
          {!draft && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Try one of these
              </div>
              <div className="flex flex-wrap gap-1">
                {examples.map(ex => (
                  <button key={ex}
                          onClick={() => setPrompt(ex)}
                          className="text-[11px] px-2 py-1 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button onClick={generate}
                  disabled={!prompt.trim() || generating}
                  data-testid="home-ai-kpi-generate"
                  className="w-full text-sm px-3 py-2 rounded-md bg-fuchsia-600 text-white font-medium hover:bg-fuchsia-700 disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {generating ? "Asking Claude…" : draft ? "Regenerate" : "Generate KPI"}
          </button>
          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 text-rose-800 p-2 text-xs">
              {error}
            </div>
          )}
          {draft && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 space-y-2"
                 data-testid="home-ai-kpi-draft">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-violet-600 font-semibold">
                    Draft preview
                  </div>
                  <div className="font-heading font-bold text-slate-900 mt-0.5">
                    {draft.name}
                  </div>
                  <div className="text-[11px] text-slate-500">{draft.description}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    Preview
                  </div>
                  <div className="font-heading text-2xl font-bold text-slate-900 tabular-nums">
                    {previewValue == null ? "—" : previewValue}
                    {draft.value_kind === "percent" && previewValue != null && "%"}
                  </div>
                </div>
              </div>
              <details className="text-[11px] text-slate-600 rounded bg-white/70 p-2 border border-violet-100">
                <summary className="cursor-pointer text-violet-700 font-medium">
                  Show generated pipeline
                </summary>
                <pre className="mt-1 text-[10px] leading-tight text-slate-700 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(draft.spec, null, 2)}
                </pre>
              </details>
              <div className="flex items-center gap-2 pt-1">
                <label className="text-[11px] text-slate-600 flex items-center gap-1">
                  <input type="radio" name="scope" value="user"
                          checked={scope === "user"}
                          onChange={() => setScope("user")}
                          data-testid="home-ai-kpi-scope-user" />
                  Just me
                </label>
                <label className="text-[11px] text-slate-600 flex items-center gap-1">
                  <input type="radio" name="scope" value="company"
                          checked={scope === "company"}
                          onChange={() => setScope("company")}
                          data-testid="home-ai-kpi-scope-company" />
                  Whole company
                </label>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={onClose}
                  className="text-sm px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={save}
                  disabled={!draft || saving}
                  data-testid="home-ai-kpi-save"
                  className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Save to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Layout / span constants
// ============================================================
// Default column-span per widget kind.
const DEFAULT_W = { kpi: 1, module: 1, donut: 1, list: 2, activity: 4, notifications: 2 };
// Resize cycle when clicking the ⤢ button.
const NEXT_W = { 1: 2, 2: 4, 4: 1 };
// Static Tailwind classes so JIT doesn't purge them.
const SPAN_CLS = {
  1: "sm:col-span-1 lg:col-span-1",
  2: "sm:col-span-2 lg:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
};
function clampSpan(w) {
  const n = parseInt(w, 10);
  if (n === 2) return 2;
  if (n === 3) return 3;
  if (n === 4) return 4;
  return 1;
}

// Icons for library widgets (used in the tray + KPI card badge).
const LIBRARY_ICONS = {
  "kpi.bank_balance":     Landmark,
  "kpi.cash_runway":      PiggyBank,
  "kpi.team_utilization": Timer,
  "list.top_customers":   Users2,
  "list.overdue_invoices": FileWarning,
};

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
