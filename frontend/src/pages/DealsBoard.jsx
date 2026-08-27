import { useEffect, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Plus, GitBranch, Loader2, TrendingUp, Filter, Trophy, XCircle,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import DealCard from "@/components/DealCard";
import DealDrawer from "@/components/DealDrawer";
import DealFormModal from "@/components/DealFormModal";

/**
 * DealsBoard — /crm/deals (Phase C kickoff, Feb 2026).
 *
 * A Trello-style Kanban with 6 stage columns (Lead · Qualified ·
 * Proposal · Negotiation · Won · Lost). Cards render deal
 * title/contact/value/probability. Drag between columns POSTs
 * /move; drop between two cards inserts with a fractional order.
 * Clicking a card opens a slide-over drawer with details,
 * activity feed, and the "Convert to Project" handoff.
 */
const STAGES = [
  { key: "lead",        label: "Lead",         tone: "bg-slate-100 text-slate-700 border-slate-200" },
  { key: "qualified",   label: "Qualified",    tone: "bg-cyan-100 text-cyan-800 border-cyan-200" },
  { key: "proposal",    label: "Proposal",     tone: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  { key: "negotiation", label: "Negotiation",  tone: "bg-amber-100 text-amber-800 border-amber-200" },
  { key: "won",         label: "Won",          tone: "bg-emerald-100 text-emerald-800 border-emerald-200", icon: Trophy },
  { key: "lost",        label: "Lost",         tone: "bg-rose-100 text-rose-800 border-rose-200", icon: XCircle },
];

export default function DealsBoard() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [selectedDealId, setSelectedDealId] = useState(null);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState({stage: null, beforeId: null});

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (ownerFilter) params.set("owner_user_id", ownerFilter);
      const r = await api.get(
        `/companies/${currentId}/deals/board?${params}`);
      setBoard(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [currentId, ownerFilter]);
  useEffect(() => { load(); }, [load]);

  const byStage = useMemo(() => {
    const m = {};
    for (const c of (board?.columns || [])) m[c.stage] = c;
    return m;
  }, [board]);

  const totals = board?.totals || { open_count: 0, open_value: 0, weighted: 0 };

  // ---------- DnD handlers ----------
  const onDragStart = (deal) => (e) => {
    setDragId(deal.id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    setDragId(null);
    setDragOver({stage: null, beforeId: null});
  };
  const onCardDragOver = (stage, beforeId) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver({stage, beforeId});
  };
  const onColumnDragOver = (stage) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    // If no card-level target set for this column yet, hint at column-end.
    setDragOver(o => o.stage === stage ? o : {stage, beforeId: null});
  };
  const onDropInto = async (stage) => {
    if (!dragId) return;
    const beforeId = dragOver.beforeId;
    // Snapshot for optimistic UI.
    setDragOver({stage: null, beforeId: null});
    setDragId(null);
    try {
      await api.post(
        `/companies/${currentId}/deals/${dragId}/move`,
        beforeId ? {stage, before_id: beforeId} : {stage});
      await load();
    } catch (e) {
      toast.error(`Move failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="max-w-none space-y-5" data-testid="deals-board-page">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <GitBranch size={22} className="text-violet-600" />
            Deals
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Drag cards between stages to move deals through your pipeline. Won deals convert to Projects with a single click.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowNew(true)}
                  data-testid="deals-new-btn"
                  className="text-sm px-4 py-1.5 rounded-md bg-violet-600 text-white font-medium hover:bg-violet-700 inline-flex items-center gap-1.5">
            <Plus size={13} /> New deal
          </button>
        </div>
      </div>

      {/* Pipeline totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Open deals"     value={totals.open_count} tone="slate"   testId="pipeline-open-count" />
        <Kpi label="Open value"     value={fmt(totals.open_value)} tone="cyan" testId="pipeline-open-value" />
        <Kpi label="Weighted pipe"  value={fmt(totals.weighted)}   tone="violet" testId="pipeline-weighted"
              icon={<TrendingUp size={13} />} />
        <Kpi label="Won this view"  value={byStage.won?.count || 0} tone="emerald"
              testId="pipeline-won-count"
              sub={fmt(byStage.won?.value_sum || 0)} />
      </div>

      {/* Kanban */}
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-[1000px]" data-testid="kanban-board">
          {STAGES.map(s => {
            const col = byStage[s.key] || { deals: [], count: 0, value_sum: 0 };
            const Icon = s.icon;
            return (
              <div key={s.key}
                    onDragOver={onColumnDragOver(s.key)}
                    onDrop={() => onDropInto(s.key)}
                    data-testid={`kanban-column-${s.key}`}
                    className={`flex-1 min-w-[220px] rounded-xl bg-slate-50/80 border ${
                      dragOver.stage === s.key
                        ? "border-violet-400 bg-violet-50/60"
                        : "border-slate-200"
                    }`}>
                <div className="px-3 py-2 border-b bg-white/70 rounded-t-xl flex items-center justify-between gap-2">
                  <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border inline-flex items-center gap-1 ${s.tone}`}>
                    {Icon && <Icon size={11} />}
                    {s.label}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono-num">
                    {col.count} · {fmt(col.value_sum)}
                  </span>
                </div>
                <div className="p-2 space-y-2 min-h-[100px]"
                      data-testid={`kanban-list-${s.key}`}>
                  {col.deals.length === 0 && (
                    <div className="text-[11px] text-slate-400 italic text-center py-6">
                      Drop deals here
                    </div>
                  )}
                  {col.deals.map(d => (
                    <div key={d.id}
                          draggable
                          onDragStart={onDragStart(d)}
                          onDragEnd={onDragEnd}
                          onDragOver={onCardDragOver(s.key, d.id)}>
                      <DealCard
                        deal={d}
                        onClick={() => setSelectedDealId(d.id)}
                        dragging={dragId === d.id}
                        insertMarker={dragOver.stage === s.key && dragOver.beforeId === d.id}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {loading && (
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Refreshing…
        </div>
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

function Kpi({ label, value, tone = "slate", sub = null, icon = null, testId }) {
  const tones = {
    slate:   "text-slate-800 bg-slate-50/70 border-slate-200",
    cyan:    "text-cyan-800 bg-cyan-50/70 border-cyan-200",
    violet:  "text-violet-800 bg-violet-50/70 border-violet-200",
    emerald: "text-emerald-800 bg-emerald-50/70 border-emerald-200",
  };
  return (
    <div data-testid={testId}
          className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-lg font-mono-num mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 font-mono-num">{sub}</div>}
    </div>
  );
}
