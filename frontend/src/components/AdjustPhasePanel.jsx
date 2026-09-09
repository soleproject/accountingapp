import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Sparkles, RefreshCw, Check, X, Loader2, ChevronDown, ChevronRight,
  Info, AlertTriangle,
} from "lucide-react";

// --------------------------------------------------------------------------
// AdjustPhasePanel — AI JE Drafters for the Adjust phase of a monthly close.
//
// Currently ships:
//   • Prepaid amortization (linear 12-month unless CoA has an explicit config)
//   • Recurring accruals (bills that hit ≥5 of last 6 months but not this one)
//
// Depreciation is intentionally NOT here — it's auto-posted at asset
// creation via `asset_service`. This panel fills the *other* gaps every
// close needs.
// --------------------------------------------------------------------------

const KIND_META = {
  prepaid_amort: { label: "Prepaid Amortization", color: "bg-blue-50 text-blue-700 border-blue-200", tone: "blue" },
  accrual:       { label: "Recurring Accrual",    color: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200", tone: "fuchsia" },
};

export default function AdjustPhasePanel({ companyId, period, onChange }) {
  const [drafts, setDrafts] = useState([]);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const load = async () => {
    if (!companyId || !period) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/je-drafters`, {
        params: { period, status: "pending" },
      });
      setDrafts(r.data.drafts || []);
      setCounts(r.data.counts || {});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load drafts.");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    if (!companyId || !period) return;
    setScanning(true);
    try {
      const r = await api.post(`/companies/${companyId}/je-drafters/scan`, { period });
      const n = r.data.count || 0;
      if (n === 0) toast.info("No adjustments needed for this period.");
      else toast.success(`Drafted ${n} adjustment${n === 1 ? "" : "s"}.`);
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Scan failed.");
    } finally {
      setScanning(false);
    }
  };

  const approve = async (id) => {
    try {
      await api.post(`/companies/${companyId}/je-drafters/${id}/approve`);
      toast.success("Posted to the ledger.");
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Approve failed.");
    }
  };

  const reject = async (id) => {
    try {
      await api.post(`/companies/${companyId}/je-drafters/${id}/reject`);
      toast.success("Rejected.");
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Reject failed.");
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId, period]);

  const totalPending = drafts.length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="adjust-phase-panel">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
          <Sparkles size={16} className="text-fuchsia-500" />
          <span className="font-semibold text-slate-900">AI Adjust Drafts</span>
          {totalPending > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-700">
              {totalPending} pending
            </span>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); scan(); }}
          disabled={scanning}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="adjust-panel-scan"
        >
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {scanning ? "Scanning…" : "Scan for adjustments"}
        </button>
      </button>

      {expanded && (
        <div className="border-t border-slate-100">
          {busy && !drafts.length && (
            <div className="text-center text-sm text-slate-500 py-6">Loading drafts…</div>
          )}

          {!busy && drafts.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-500" data-testid="adjust-panel-empty">
              <Info className="mx-auto text-slate-300 mb-2" size={24} />
              No pending adjustments for {period}.
              <div className="text-xs text-slate-400 mt-1">
                Click "Scan for adjustments" to look for prepaid amortization and recurring accruals.
              </div>
            </div>
          )}

          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onApprove={() => approve(d.id)}
              onReject={() => reject(d.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({ draft, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);
  const meta = KIND_META[draft.drafter_kind] || KIND_META.accrual;
  const needsReview = !!draft.needs_review_reason;
  const confPct = Math.round((draft.confidence || 0) * 100);

  return (
    <div
      className="border-t border-slate-100 px-4 py-3 hover:bg-slate-50/50"
      data-testid={`adjust-panel-draft-${draft.id}`}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-slate-400 hover:text-slate-700 mt-0.5"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.color} border`}>
              {meta.label}
            </span>
            <span className="text-sm font-semibold text-slate-900">
              ${draft.amount?.toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-500">·</span>
            <span className="text-[11px] text-slate-500">
              {confPct}% confidence
            </span>
            {needsReview && (
              <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex items-center gap-0.5">
                <AlertTriangle size={10} /> {draft.needs_review_reason}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-600 mt-0.5 truncate">{draft.memo}</div>
          {expanded && (
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left font-medium">Account</th>
                    <th className="text-right font-medium w-20">Debit</th>
                    <th className="text-right font-medium w-20">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {(draft.lines || []).map((ln, i) => (
                    <tr key={i} className="border-t border-slate-200">
                      <td className="py-1">{ln.account_name || ln.account_id || "—"}</td>
                      <td className="py-1 text-right font-mono-num">
                        {ln.debit ? `$${Number(ln.debit).toFixed(2)}` : ""}
                      </td>
                      <td className="py-1 text-right font-mono-num">
                        {ln.credit ? `$${Number(ln.credit).toFixed(2)}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onReject}
            className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            data-testid={`adjust-panel-reject-${draft.id}`}
            title="Reject draft"
          >
            <X size={12} />
          </button>
          <button
            onClick={onApprove}
            disabled={needsReview}
            className="p-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed flex items-center gap-1"
            data-testid={`adjust-panel-approve-${draft.id}`}
            title={needsReview ? draft.needs_review_reason : "Approve & post JE"}
          >
            <Check size={12} /> Post
          </button>
        </div>
      </div>
    </div>
  );
}
