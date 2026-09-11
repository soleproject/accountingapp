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
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  CheckCircle2, ChevronLeft, ChevronRight, Loader2, ExternalLink,
  Circle, Clock, RefreshCw, Sliders, ChevronDown,
} from "lucide-react";
import ResponsibilitiesModal from "@/components/ResponsibilitiesModal";
import ReorderAlertsTile from "@/components/ReorderAlertsTile";
import ReconciliationAccountsTile from "@/components/ReconciliationAccountsTile";
import MonthCloseChecklistTile from "@/components/MonthCloseChecklistTile";
import OverdueInvoicesTile from "@/components/OverdueInvoicesTile";
import OverdueBillsTile from "@/components/OverdueBillsTile";
import SalesTaxTile from "@/components/SalesTaxTile";

const STATUS_TONES = {
  done:         "border-emerald-200 bg-emerald-50/40 text-emerald-900",
  in_progress:  "border-amber-200 bg-amber-50/40 text-amber-900",
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
  preamble = null,
}) {
  const fmtMoney = useMoneyFmt();
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // Items whose inline dropdown is expanded (e.g. Monitoring Inventory
  // shows the ReorderAlertsTile inside its row instead of navigating
  // away to the Dashboard).
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpanded = (key) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

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
  // "← Back to …" breadcrumb. Handles hash fragments correctly —
  // query params must live BEFORE the `#…` so the anchor scroll still
  // fires when the browser lands on the page.
  const buildOpenHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const hashIdx = base.indexOf("#");
    const path = hashIdx >= 0 ? base.slice(0, hashIdx) : base;
    const hash = hashIdx >= 0 ? base.slice(hashIdx) : "";
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}${hash}`;
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

      {/* Optional preamble — rendered above the items list. Used by
          Client Cockpit to hoist the Monitoring Cash Flow card into
          the responsibilities section as its top row. */}
      {preamble}

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
          {items.map(item => {
            const isInventory = item.key === "monitoring_inventory";
            const isReconciling = item.key === "reconciling_accounts";
            const isEomClosing = item.key === "eom_closing";
            const isInvoices = item.key === "following_up_invoices";
            const isBills = item.key === "paying_bills";
            const isSalesTax = item.key === "paying_sales_tax";
            const isExpandable = isInventory || isReconciling || isEomClosing || isInvoices || isBills || isSalesTax;
            const isOpen = expanded.has(item.key);
            return (
            <li
              key={item.key}
              className={`rounded-lg border ${STATUS_TONES[item.status] || STATUS_TONES.not_started}`}
              data-testid={`resp-item-${item.key}`}
            >
              <div className="p-3 flex items-center gap-3">
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
                        {b.label}: <b className="font-mono-num">{b.is_money ? fmtMoney(b.count) : b.count}</b>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] mt-0.5 opacity-80">{item.detail}</div>
                )}
              </div>
              {isExpandable && (item.count ?? 0) >= 0 && (isReconciling || isEomClosing || isSalesTax || item.count > 0) ? (
                <button
                  onClick={() => toggleExpanded(item.key)}
                  className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 shrink-0"
                  data-testid={`resp-item-${item.key}-open`}
                >
                  {isOpen ? "Hide" : "Open"}
                  <ChevronDown size={12} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
              ) : item.area_link ? (
                <Link
                  to={buildOpenHref(item.area_link)}
                  className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 shrink-0"
                  data-testid={`resp-item-${item.key}-open`}
                >
                  Open <ExternalLink size={10} />
                </Link>
              ) : null}
              </div>
              {/* Inline dropdowns — mirror the Monitoring Inventory pattern
                  so each expandable row reuses its dedicated tile. */}
              {isInventory && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <ReorderAlertsTile currentId={companyId} variant="slate" />
                </div>
              )}
              {isReconciling && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <ReconciliationAccountsTile
                    companyId={companyId}
                    period={period}
                    returnPath={returnPath}
                    returnLabel={returnLabel}
                  />
                </div>
              )}
              {isEomClosing && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <MonthCloseChecklistTile
                    companyId={companyId}
                    period={period}
                    returnPath={returnPath}
                    returnLabel={returnLabel}
                  />
                </div>
              )}
              {isInvoices && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <OverdueInvoicesTile
                    companyId={companyId}
                    returnPath={returnPath}
                    returnLabel={returnLabel}
                  />
                </div>
              )}
              {isBills && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <OverdueBillsTile
                    companyId={companyId}
                    returnPath={returnPath}
                    returnLabel={returnLabel}
                  />
                </div>
              )}
              {isSalesTax && isOpen && (
                <div className="px-3 pb-3" data-testid={`resp-item-${item.key}-expanded`}>
                  <SalesTaxTile
                    companyId={companyId}
                    period={period}
                    returnPath={returnPath}
                    returnLabel={returnLabel}
                  />
                </div>
              )}
            </li>
          )})}
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
