import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, Clock,
  ExternalLink, Info,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Close Board
// Kanban of every accessible client, columns = close phases.
// --------------------------------------------------------------------------

const PHASES = [
  { key: "not_started",    label: "Not started",    accent: "bg-slate-100 text-slate-700",       ring: "border-slate-200" },
  { key: "cleanup",        label: "Cleanup",        accent: "bg-indigo-50 text-indigo-700",      ring: "border-indigo-200" },
  { key: "reconciling",    label: "Reconciling",    accent: "bg-cyan-50 text-cyan-700",          ring: "border-cyan-200" },
  { key: "adjusting",      label: "Adjusting",      accent: "bg-fuchsia-50 text-fuchsia-700",    ring: "border-fuchsia-200" },
  { key: "client_review",  label: "Client review",  accent: "bg-amber-50 text-amber-700",        ring: "border-amber-200" },
  { key: "ready_to_close", label: "Ready to close", accent: "bg-emerald-50 text-emerald-700",    ring: "border-emerald-200" },
  { key: "closed",         label: "Closed",         accent: "bg-slate-800 text-white",           ring: "border-slate-700" },
];

function currentYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function shiftYm(y, m, delta) {
  const d = new Date(y, m - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function ymKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }
function ymLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export default function CockpitCloseBoard() {
  const nav = useNavigate();
  const [cursor, setCursor] = useState(currentYm());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragCid, setDragCid] = useState(null);

  const load = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/cockpit/close-board`, {
        params: { period: ymKey(cursor.year, cursor.month) },
      });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load close board.");
      setData({ period: ymKey(cursor.year, cursor.month), cards: [], summary: {} });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cursor.year, cursor.month]);

  const cardsByPhase = useMemo(() => {
    const map = {};
    for (const p of PHASES) map[p.key] = [];
    for (const c of data?.cards || []) {
      (map[c.phase] || (map[c.phase] = [])).push(c);
    }
    return map;
  }, [data]);

  const onDrop = async (toPhase, cid) => {
    if (!cid) return;
    const card = (data?.cards || []).find((c) => c.company_id === cid);
    if (!card) return;
    if (card.phase === toPhase) return;
    try {
      const r = await api.post(`/cockpit/close-board/advance`, {
        company_id: cid,
        period: card.period,
        to_phase: toPhase,
      });
      // Replace the card in state.
      setData((d) => ({
        ...d,
        cards: (d.cards || []).map((c) =>
          c.company_id === cid ? r.data.card : c
        ),
      }));
      toast.success(
        toPhase === "closed"
          ? `Closed ${card.period} for ${card.company_name}.`
          : `Moved to ${PHASES.find((p) => p.key === toPhase)?.label}.`,
      );
    } catch (e) {
      const detail = e?.response?.data?.detail;
      const msg = typeof detail === "object" ? detail?.message : (detail || e.message);
      toast.error(msg || "Move failed.");
    }
  };

  const summary = data?.summary || {};

  return (
    <div className="p-6" data-testid="cockpit-close-board-page">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Close · {data?.summary?.total ?? 0} client{data?.summary?.total === 1 ? "" : "s"}
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            {ymLabel(cursor.year, cursor.month)}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border border-slate-300 rounded-md bg-white">
            <button
              onClick={() => setCursor((c) => shiftYm(c.year, c.month, -1))}
              className="p-1.5 hover:bg-slate-50 border-r border-slate-200"
              data-testid="cockpit-close-prev-month"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setCursor(currentYm())}
              className="px-2 text-xs font-medium hover:bg-slate-50 py-1.5"
              data-testid="cockpit-close-today-month"
            >
              This month
            </button>
            <button
              onClick={() => setCursor((c) => shiftYm(c.year, c.month, 1))}
              className="p-1.5 hover:bg-slate-50 border-l border-slate-200"
              data-testid="cockpit-close-next-month"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            onClick={load}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
            data-testid="cockpit-close-refresh"
          >
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary strip — always rendered so downstream tests and
          screen readers see a stable landmark. Content only when
          there's something worth flagging. */}
      <div className="mb-4 flex items-center gap-3 flex-wrap min-h-[28px]" data-testid="cockpit-close-summary">
        {summary.overdue_count > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-full px-2.5 py-1">
            <AlertTriangle size={12} />
            {summary.overdue_count} overdue
          </div>
        )}
        {summary.at_risk_count > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">
            <Clock size={12} />
            {summary.at_risk_count} due within 3 days
          </div>
        )}
        {!summary.overdue_count && !summary.at_risk_count && data && (
          <span className="text-xs text-slate-400 italic">
            No overdue or at-risk closes.
          </span>
        )}
      </div>

      {/* Kanban */}
      <div className="flex gap-3 overflow-x-auto pb-4" data-testid="cockpit-close-kanban">
        {PHASES.map((phase) => {
          const cards = cardsByPhase[phase.key] || [];
          return (
            <div
              key={phase.key}
              className="w-72 shrink-0"
              data-testid={`cockpit-close-column-${phase.key}`}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); onDrop(phase.key, dragCid); setDragCid(null); }}
            >
              <div className={`rounded-md ${phase.accent} px-3 py-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider`}>
                <span>{phase.label}</span>
                <span className="font-mono-num text-[11px] opacity-80">{cards.length}</span>
              </div>
              <div className={`mt-2 space-y-2 min-h-[120px] p-1.5 rounded-md border-2 border-dashed ${
                dragCid ? "border-indigo-300 bg-indigo-50/30" : "border-transparent"
              }`}>
                {cards.length === 0 && !busy && (
                  <div className="text-xs text-slate-400 text-center py-6 italic">
                    No clients here
                  </div>
                )}
                {cards.map((card) => (
                  <CloseCard
                    key={card.company_id}
                    card={card}
                    phase={phase}
                    onDragStart={() => setDragCid(card.company_id)}
                    onDragEnd={() => setDragCid(null)}
                    onOpen={() => nav(`/accounting/month-close?ym=${card.period}`)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {busy && !data?.cards?.length && (
        <div className="text-center text-slate-500 py-12 text-sm">Loading close board…</div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Individual card
// --------------------------------------------------------------------------

function CloseCard({ card, phase, onDragStart, onDragEnd, onOpen }) {
  const nav = useNavigate();
  const scoreColor =
    card.close_score >= 90 ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : card.close_score >= 60 ? "text-amber-700 bg-amber-50 border-amber-200"
    : "text-red-700 bg-red-50 border-red-200";

  const deadlineColor =
    card.days_to_deadline < 0 ? "text-red-600"
    : card.days_to_deadline <= 3 ? "text-amber-600"
    : "text-slate-500";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className="bg-white rounded-md border border-slate-200 p-3 shadow-sm hover:shadow-md hover:border-indigo-300 cursor-pointer transition-all"
      data-testid={`cockpit-close-card-${card.company_id}`}
    >
      {/* Top row: name + score */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {card.brand_logo_url ? (
            <img
              src={card.brand_logo_url}
              alt=""
              className="w-5 h-5 rounded object-cover shrink-0"
              onError={(e) => { e.target.style.display = "none"; }}
            />
          ) : null}
          <span className="text-sm font-semibold text-slate-900 truncate">
            {card.company_name}
          </span>
        </div>
        <div
          className={`text-[10px] font-mono-num font-semibold border rounded px-1.5 py-0.5 shrink-0 ${scoreColor}`}
          title={`Close score: ${card.close_score}/100`}
        >
          {card.close_score}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${card.phase_pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px] text-slate-500">
          <span>{card.phase_pct}% complete</span>
          <span className={deadlineColor}>
            {card.days_to_deadline < 0
              ? `${Math.abs(card.days_to_deadline)}d overdue`
              : card.days_to_deadline === 0
                ? "Due today"
                : `${card.days_to_deadline}d to deadline`}
          </span>
        </div>
      </div>

      {/* Blockers */}
      {card.top_blockers && card.top_blockers.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {card.top_blockers.slice(0, 3).map((b, i) => (
            <div key={i} className="text-[11px] text-slate-600 flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-slate-400" />
              <span className="truncate">{b.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Quick actions */}
      <div className="flex items-center gap-1 pt-2 border-t border-slate-100">
        {(card.quick_actions || []).slice(0, 3).map((qa) => (
          <button
            key={qa.kind}
            onClick={(e) => { e.stopPropagation(); nav(qa.route); }}
            className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 flex items-center gap-1"
            data-testid={`cockpit-close-card-${card.company_id}-action-${qa.kind}`}
            title={qa.label}
          >
            {qa.label}
          </button>
        ))}
      </div>
    </div>
  );
}
