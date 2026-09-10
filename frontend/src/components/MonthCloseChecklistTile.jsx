/**
 * MonthCloseChecklistTile
 *
 * Inline dropdown for the "End of Month Closing" row on the
 * Responsibilities panel. Always renders the 5 checkpoints for the
 * PREVIOUS month (you can't close a month that isn't over yet).
 *
 * Mirrors the checklist card on `/accounting/month-close` so both
 * surfaces stay visually consistent.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  CheckCircle2, Circle, Loader2, ListChecks, FileText, Receipt,
  Banknote, Lock, ArrowRight,
} from "lucide-react";

const ROWS = [
  { key: "txns_reviewed", label: "All Transactions Reviewed",              icon: ListChecks },
  { key: "invoices",      label: "Outstanding Invoices Reviewed & signed off", icon: FileText },
  { key: "bills",         label: "Outstanding Bills Reviewed & signed off",    icon: Receipt },
  { key: "recon",         label: "Reconciliation Complete",                    icon: Banknote },
  { key: "closed",        label: "Closed",                                     icon: Lock },
];

function subText(key, cp) {
  if (!cp) return "";
  if (key === "txns_reviewed") {
    if ((cp.total || 0) === 0) return "No transactions this month.";
    const un = cp.uncategorized || 0;
    const nr = cp.unreviewed || 0;
    if (un === 0 && nr === 0) return `All ${cp.total} transactions reviewed.`;
    const parts = [];
    if (un) parts.push(`${un} uncategorized`);
    if (nr) parts.push(`${nr} unreviewed`);
    return parts.join(" · ");
  }
  if (key === "invoices") {
    return `${cp.outstanding || 0} outstanding invoices`;
  }
  if (key === "bills") {
    return `${cp.outstanding || 0} outstanding bills`;
  }
  if (key === "recon") {
    if ((cp.total || 0) === 0) return "No cleared txns yet.";
    return `${cp.cleared || 0} of ${cp.total} txns cleared`;
  }
  if (key === "closed") {
    return cp.signed_at ? `Locked ${cp.signed_at.slice(0, 10)}` : "Not yet locked";
  }
  return "";
}

export default function MonthCloseChecklistTile({ companyId, period }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/responsibilities/month-close-detail`, {
        params: { period },
      });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load Month Close.");
    } finally {
      setBusy(false);
    }
  }, [companyId, period]);

  useEffect(() => { load(); }, [load]);

  if (busy && !data) {
    return (
      <div className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  if (!data) return null;

  const cps = data.checkpoints || {};
  const greenCount = ROWS.reduce((n, r) => n + ((cps[r.key] || {}).green ? 1 : 0), 0);

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="month-close-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px]">
        <div className="text-slate-700">
          <span className="font-semibold">{data.close_period_label}</span>
          <span className="text-slate-400"> · {data.period_start} → {data.period_end}</span>
          <span className="text-slate-400"> · </span>
          <b>{greenCount}</b> of <b>{ROWS.length}</b> signed
        </div>
        <Link
          to={data.deep_link}
          className="text-cyan-700 hover:underline inline-flex items-center gap-1"
          data-testid="month-close-tile-open"
        >
          Open Month Close <ArrowRight size={11} />
        </Link>
      </div>
      <ul className="divide-y">
        {ROWS.map(r => {
          const cp = cps[r.key] || {};
          const Icon = r.icon;
          const green = !!cp.green;
          return (
            <li
              key={r.key}
              className="px-3 py-2 flex items-center gap-3 text-sm"
              data-testid={`month-close-tile-row-${r.key}`}
            >
              <span className={`p-1.5 rounded ${green ? "bg-emerald-50" : "bg-slate-50"}`}>
                <Icon size={13} className={green ? "text-emerald-600" : "text-slate-400"} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900 truncate">{r.label}</div>
                <div className="text-[11px] text-slate-500 truncate">{subText(r.key, cp)}</div>
              </div>
              {green ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold"
                  data-testid={`month-close-tile-status-${r.key}`}
                >
                  <CheckCircle2 size={10} /> {cp.auto ? "Auto" : "Signed"}
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold"
                  data-testid={`month-close-tile-status-${r.key}`}
                >
                  <Circle size={10} /> Open
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
