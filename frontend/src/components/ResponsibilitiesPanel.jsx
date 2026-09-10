/**
 * ResponsibilitiesPanel — the actual list view shown on To Do and
 * Client Cockpit. Wraps the status endpoint with a month switcher, a
 * manual-complete toggle for untracked items, and a "Responsibilities"
 * button that opens the edit modal.
 *
 * Props:
 *   companyId       — the client we're rendering for
 *   scope           — "client" (To Do) | "accountant" (Client Cockpit)
 *   emptyStateHint  — copy for the "No items assigned yet" state
 *   returnLabel     — label for the breadcrumb back link ("Back to …")
 *   returnPath      — path to return to when clicking area links
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  CheckCircle2, ChevronLeft, ChevronRight, Loader2, ExternalLink,
  Circle, Clock, RefreshCw, Sliders,
} from "lucide-react";
import ResponsibilitiesModal from "@/components/ResponsibilitiesModal";

const STATUS_TONES = {
  done:         "border-emerald-200 bg-emerald-50 text-emerald-900",
  in_progress:  "border-amber-200 bg-amber-50 text-amber-900",
  not_started:  "border-slate-200 bg-white text-slate-700",
  "n/a":        "border-slate-200 bg-slate-50 text-slate-500",
};

const StatusIcon = ({ status }) =>
  status === "done" ? <CheckCircle2 size={14} className="text-emerald-600" /> :
  status === "in_progress" ? <Clock size={14} className="text-amber-600" /> :
  <Circle size={14} className="text-slate-400" />;

const shiftPeriod = (period, delta) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear().toString().padStart(4, "0")}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}`;
};

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
};

const monthLabel = (period) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
};

export default function ResponsibilitiesPanel({
  companyId,
  scope,
  emptyStateHint = "No responsibilities have been set for you yet.",
  returnLabel,
  returnPath,
}) {
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/responsibilities/status`, {
        params: { period, scope },
      });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load responsibilities.");
    } finally {
      setBusy(false);
    }
  }, [companyId, period, scope]);

  useEffect(() => { load(); }, [load]);

  const toggleComplete = async (item) => {
    if (item.tracked) return;
    try {
      await api.post(`/companies/${companyId}/responsibilities/complete`, {
        item_key: item.key,
        period,
        completed: !item.manual_complete,
      });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed.");
    }
  };

  const isCurrent = data?.is_current !== false;
  const items = data?.items || [];

  // Build a link href for the "Open →" affordance. If we have a
  // returnPath, tag it in the query so the target page can render a
  // "← Back to …" breadcrumb.
  const buildOpenHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  return (
    <div className="space-y-3" data-testid="responsibilities-panel">
      {/* Header + month switcher */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPeriod(shiftPeriod(period, -1))}
            className="p-1 border border-slate-300 rounded hover:bg-slate-50"
            data-testid="resp-panel-prev-month"
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="text-sm font-semibold text-slate-900 min-w-[140px] text-center">
            {monthLabel(period)}
            {isCurrent && <span className="ml-1.5 text-[10px] text-slate-400 font-normal">(current)</span>}
          </div>
          <button
            onClick={() => setPeriod(shiftPeriod(period, +1))}
            disabled={period === currentPeriod()}
            className="p-1 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40"
            data-testid="resp-panel-next-month"
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
          {period !== currentPeriod() && (
            <button
              onClick={() => setPeriod(currentPeriod())}
              className="text-[11px] px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
              data-testid="resp-panel-today"
            >
              Today
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={load}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-50"
            data-testid="resp-panel-refresh"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1"
            data-testid="resp-panel-edit"
          >
            <Sliders size={11} /> Responsibilities
          </button>
        </div>
      </div>

      {/* List */}
      {busy && !data ? (
        <div className="py-10 flex items-center justify-center text-slate-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
          <div className="text-sm text-slate-700 font-medium">{emptyStateHint}</div>
          <div className="text-xs text-slate-500 mt-1">
            Click <b>Responsibilities</b> above to assign items.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map(item => (
            <li
              key={item.key}
              className={`rounded-lg border p-3 flex items-center gap-3 ${STATUS_TONES[item.status] || STATUS_TONES.not_started}`}
              data-testid={`resp-item-${item.key}`}
            >
              <button
                onClick={() => toggleComplete(item)}
                disabled={item.tracked}
                title={item.tracked ? "Status is computed automatically" : (item.manual_complete ? "Uncheck to mark incomplete" : "Mark done for this month")}
                className={`shrink-0 ${item.tracked ? "cursor-default" : "cursor-pointer hover:scale-110"} transition`}
                data-testid={`resp-item-${item.key}-toggle`}
              >
                <StatusIcon status={item.status} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {item.label}
                  {item.assignment === "both" && (
                    <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-slate-200 text-slate-700 font-normal">
                      shared
                    </span>
                  )}
                </div>
                {item.breakdown && item.breakdown.length > 0 ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {item.breakdown.map(b => (
                      <Link
                        key={b.label}
                        to={buildOpenHref(b.href)}
                        className="text-slate-700 hover:text-slate-900 hover:underline"
                        data-testid={`resp-item-${item.key}-bucket-${b.label.replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        {b.label}: <b className="font-mono-num">{b.count}</b>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] mt-0.5 opacity-80">{item.detail}</div>
                )}
              </div>
              {item.area_link && (
                <Link
                  to={buildOpenHref(item.area_link)}
                  className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 shrink-0"
                  data-testid={`resp-item-${item.key}-open`}
                >
                  Open <ExternalLink size={10} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <ResponsibilitiesModal
        companyId={companyId}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={load}
      />
    </div>
  );
}
