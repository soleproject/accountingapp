import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ClipboardCheck, Loader2, Check, X, AlertTriangle, RotateCcw,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * TimesheetApprovals — /team/approvals (Phase B-3 polish, Feb 2026).
 *
 * The manager's queue of "submitted" time entries awaiting review.
 * Managers can approve or reject individually, bulk-approve the
 * selected rows, and jump to a "recently reviewed" tab to see the
 * last approved/rejected batch (with an undo route via /submit).
 */
export default function TimesheetApprovals() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [tab, setTab] = useState("submitted"); // "submitted" | "approved" | "rejected"
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/time-entries?status=${tab}`);
      setRows(r.data?.time_entries || []);
      setSelected(new Set());
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, tab]);

  const toggle = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(s => s.size === rows.length ? new Set() : new Set(rows.map(r => r.id)));
  };

  const bulkApprove = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/time-entries/bulk-approve`,
        { ids: Array.from(selected) });
      toast.success(`Approved ${r.data?.count || 0} entries`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const act = async (t, action, note = "") => {
    try {
      await api.post(
        `/companies/${currentId}/time-entries/${t.id}/${action}`,
        note ? { note } : {});
      toast.success(action === "approve" ? "Approved" :
                    action === "reject"  ? "Rejected" :
                    action === "submit"  ? "Re-submitted" : "Updated");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const totals = useMemo(() => {
    const hours = rows.reduce((s, r) => s + Number(r.hours || 0), 0);
    const cost  = rows.reduce((s, r) =>
      s + Number(r.hours || 0) * Number(r.cost_rate_snapshot || 0), 0);
    return { hours: round2(hours), cost: round2(cost) };
  }, [rows]);

  return (
    <div className="max-w-6xl space-y-5" data-testid="approvals-page">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardCheck size={22} className="text-emerald-600" />
          Timesheet approvals
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Review submitted time entries before they roll into project labor cost. Approved entries flow into the project P&amp;L; rejected ones are excluded.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b" data-testid="approvals-tabs">
        {[
          ["submitted", "Awaiting review"],
          ["approved",  "Approved"],
          ["rejected",  "Rejected"],
        ].map(([k, label]) => (
          <button key={k}
                  onClick={() => setTab(k)}
                  data-testid={`approvals-tab-${k}`}
                  className={`px-3 py-2 text-sm border-b-2 -mb-px transition ${
                    tab === k
                      ? "border-emerald-600 text-emerald-700 font-medium"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}>
            {label}
            {tab === k && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono-num bg-emerald-100 text-emerald-700">
                {rows.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Bulk toolbar */}
      {tab === "submitted" && rows.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap"
              data-testid="approvals-bulk-toolbar">
          <div className="text-xs text-slate-600">
            {selected.size} of {rows.length} selected · <b className="font-mono-num">{totals.hours}</b> hrs · {fmt(totals.cost)}
          </div>
          <button onClick={bulkApprove}
                  disabled={selected.size === 0 || busy}
                  data-testid="approvals-bulk-approve"
                  className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Approve selected
          </button>
        </div>
      )}

      {/* List */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2 grid grid-cols-12 gap-2 bg-slate-50 border-b text-[11px] uppercase tracking-wider text-slate-500">
          {tab === "submitted" && (
            <div className="col-span-1">
              <input type="checkbox"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      data-testid="approvals-select-all" />
            </div>
          )}
          <div className={tab === "submitted" ? "col-span-2" : "col-span-3"}>Employee</div>
          <div className="col-span-2">Date</div>
          <div className="col-span-3">Project · Phase</div>
          <div className="col-span-1 text-right">Hours</div>
          <div className="col-span-1 text-right">Cost</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-slate-500 text-sm">
            <Loader2 size={14} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            {tab === "submitted"
              ? "Inbox zero — no entries awaiting review."
              : `No ${tab} entries yet.`}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="approvals-list">
            {rows.map(t => (
              <li key={t.id}
                  data-testid={`approvals-row-${t.id}`}
                  className={`px-4 py-2.5 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 ${
                    selected.has(t.id) ? "bg-emerald-50/40" : ""
                  }`}>
                {tab === "submitted" && (
                  <div className="col-span-1">
                    <input type="checkbox"
                            checked={selected.has(t.id)}
                            onChange={() => toggle(t.id)}
                            data-testid={`approvals-select-${t.id}`} />
                  </div>
                )}
                <div className={`${tab === "submitted" ? "col-span-2" : "col-span-3"} text-sm text-slate-800 truncate`}>
                  {t.employee_name}
                  {t.billable === false && (
                    <span className="ml-1 text-[9px] uppercase tracking-wider text-slate-500 bg-slate-100 border border-slate-200 rounded px-1">non-bill</span>
                  )}
                </div>
                <div className="col-span-2 text-xs text-slate-500 font-mono-num">{t.date}</div>
                <div className="col-span-3 text-xs text-slate-600 truncate">
                  <span className="text-slate-800">{t.project_name}</span>
                  {t.phase_name && <span className="text-slate-500"> · {t.phase_name}</span>}
                  {t.notes && <div className="text-[11px] text-slate-500 italic truncate">{t.notes}</div>}
                </div>
                <div className="col-span-1 text-right font-mono-num text-sm text-slate-800">{Number(t.hours).toFixed(2)}</div>
                <div className="col-span-1 text-right font-mono-num text-xs text-emerald-700">
                  {fmt(Number(t.hours) * Number(t.cost_rate_snapshot || 0))}
                </div>
                <div className="col-span-2 flex justify-end gap-1">
                  {tab === "submitted" && (
                    <>
                      <button onClick={() => act(t, "approve")}
                              data-testid={`approvals-approve-${t.id}`}
                              className="text-xs px-2 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 inline-flex items-center gap-1">
                        <Check size={11} /> Approve
                      </button>
                      <button onClick={() => {
                                const note = window.prompt("Reject with note (optional):", "");
                                if (note !== null) act(t, "reject", note);
                              }}
                              data-testid={`approvals-reject-${t.id}`}
                              className="text-xs px-2 py-1 rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 inline-flex items-center gap-1">
                        <X size={11} /> Reject
                      </button>
                    </>
                  )}
                  {tab === "approved" && (
                    <button onClick={() => act(t, "reject")}
                            data-testid={`approvals-unapprove-${t.id}`}
                            className="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 inline-flex items-center gap-1"
                            title="Send back to submitted queue">
                      <RotateCcw size={11} /> Undo
                    </button>
                  )}
                  {tab === "rejected" && (
                    <button onClick={() => act(t, "approve")}
                            data-testid={`approvals-reapprove-${t.id}`}
                            className="text-xs px-2 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 inline-flex items-center gap-1">
                      <Check size={11} /> Approve
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="text-[11px] text-slate-500 italic flex items-start gap-1.5">
        <AlertTriangle size={11} className="mt-0.5 text-slate-400 shrink-0" />
        Only approved entries roll into Project P&amp;L labor cost. Submitted or rejected entries don't hit dashboards until you approve them.
      </div>
    </div>
  );
}

function round2(n) { return Math.round(n * 100) / 100; }
