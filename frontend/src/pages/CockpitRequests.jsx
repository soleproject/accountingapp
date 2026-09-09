import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  MessageSquare, Send, XCircle, RefreshCw, Clock, CheckCircle2,
  AlertTriangle, Filter,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Client Requests rail
// Cross-client view of every client_questions doc. Filter by status +
// company. Row-click opens the thread on the transaction page. Bulk
// resend/cancel available on selection.
// --------------------------------------------------------------------------

const STATUS_META = {
  open:      { label: "Open",      color: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500" },
  answered:  { label: "Answered",  color: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  expired:   { label: "Expired",   color: "bg-slate-50 text-slate-600 border-slate-200",       dot: "bg-slate-400" },
  cancelled: { label: "Cancelled", color: "bg-slate-50 text-slate-600 border-slate-200",       dot: "bg-slate-400" },
};

export default function CockpitRequests() {
  const nav = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [statusFilter, setStatusFilter] = useState("open");
  const [companies, setCompanies] = useState([]);
  const [companyFilter, setCompanyFilter] = useState("");
  const [busy, setBusy] = useState(false);

  // Deep-link support: ?company=<cid> pre-filters this rail. Every
  // portal-related Today card + agent finding lands here scoped.
  useEffect(() => {
    const qp = new URLSearchParams(location.search);
    const cid = qp.get("company") || qp.get("company_ids");
    const status = qp.get("status");
    const flow = qp.get("flow");
    if (cid) setCompanyFilter(cid);
    if (status) setStatusFilter(status);
    if (flow === "receipts") setStatusFilter("open");  // sensible default
    if (cid || status || flow) nav(location.pathname, { replace: true });
    /* eslint-disable-next-line */
  }, []);

  const load = async () => {
    setBusy(true);
    try {
      const params = { status: statusFilter, limit: 500 };
      if (companyFilter) params.company_ids = companyFilter;
      const r = await api.get(`/cockpit/requests`, { params });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load requests.");
      setData({ items: [], counts: {} });
    } finally {
      setBusy(false);
    }
  };

  const loadCompanies = async () => {
    try {
      const r = await api.get(`/cockpit/accessible-companies`);
      setCompanies(r.data?.companies || []);
    } catch (e) {
      setCompanies([]);
    }
  };

  useEffect(() => { loadCompanies(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter, companyFilter]);

  // Poll every 15s so answers land here without a manual refresh — the
  // "auto-unblock" story for the Close Board flows through this feed too.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [statusFilter, companyFilter]);

  const items = data?.items || [];
  const counts = data?.counts || {};

  const resend = async (qid) => {
    try {
      await api.post(`/cockpit/requests/${qid}/resend`);
      toast.success("Reminder resent.");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Resend failed.");
    }
  };

  const cancel = async (qid) => {
    if (!window.confirm("Cancel this request? The client will no longer see it.")) return;
    try {
      await api.post(`/cockpit/requests/${qid}/cancel`);
      toast.success("Request cancelled.");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Cancel failed.");
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-requests-page">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Cockpit
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            Client Requests
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Every open question, receipt request, and doc ask across every client.
            Answers appear here automatically — this rail unblocks Close Board cards in real time.
          </p>
        </div>
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="cockpit-requests-refresh"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Filter row */}
      <div className="mb-5 flex items-center gap-2 flex-wrap" data-testid="cockpit-requests-filter-row">
        <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1">
          <Filter size={12} /> Status
        </span>
        {["open", "answered", "cancelled", "all"].map((s) => {
          const active = statusFilter === s;
          const cnt = counts[s] || 0;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              data-testid={`cockpit-requests-filter-${s}`}
              className={`text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5 transition-colors capitalize ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
              }`}
            >
              {s}
              {s !== "all" && <span className="font-mono-num opacity-80">{cnt}</span>}
            </button>
          );
        })}
        <span className="mx-2 text-slate-300">·</span>
        {companies.length > 0 && (
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="text-xs px-2.5 py-1 border border-slate-300 rounded-full bg-white"
            data-testid="cockpit-requests-filter-company"
          >
            <option value="">All clients</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {counts.stale > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 flex items-center gap-1.5"
                data-testid="cockpit-requests-stale-badge">
            <AlertTriangle size={12} />
            {counts.stale} stale (7+ days)
          </span>
        )}
      </div>

      {/* Table */}
      {items.length === 0 && !busy && (
        <div className="bg-white rounded-lg border border-slate-200 p-12 text-center" data-testid="cockpit-requests-empty">
          <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={40} />
          <div className="text-lg font-semibold text-slate-900">
            {statusFilter === "open" ? "No open client requests." : "Nothing here."}
          </div>
          <div className="text-sm text-slate-600 mt-1">
            {statusFilter === "open" && "You're not waiting on anyone right now."}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs uppercase tracking-wide text-slate-600">
                <th className="px-3 py-2">Question</th>
                <th className="px-3 py-2 w-40">Client</th>
                <th className="px-3 py-2 w-32">Status</th>
                <th className="px-3 py-2 w-24">Age</th>
                <th className="px-3 py-2 w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const meta = STATUS_META[r.status === "pending" || r.status === "sent" ? "open" : r.status] || STATUS_META.open;
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-slate-100 hover:bg-slate-50/50 ${r.stale ? "bg-red-50/30" : ""}`}
                    data-testid={`cockpit-requests-row-${r.id}`}
                  >
                    <td className="px-3 py-2.5 align-top">
                      <div className="flex items-start gap-2">
                        <MessageSquare size={14} className="text-slate-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm text-slate-900 line-clamp-2">{r.question}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {r.asked_by_name ? `${r.asked_by_name} · ` : ""}
                            {r.to_email}
                            {r.txn_count > 0 && ` · ${r.txn_count} txn${r.txn_count === 1 ? "" : "s"}`}
                            {r.chat_msg_count > 0 && ` · ${r.chat_msg_count} chat msg${r.chat_msg_count === 1 ? "" : "s"}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top text-sm text-slate-700 truncate max-w-[160px]">
                      {r.company_name}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${meta.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-top text-sm">
                      <span className={`inline-flex items-center gap-1 ${r.stale ? "text-red-600 font-semibold" : "text-slate-600"}`}>
                        <Clock size={11} />
                        {r.age_days}d
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-top text-right">
                      <div className="inline-flex items-center gap-1">
                        {(r.status === "pending" || r.status === "sent") && (
                          <>
                            <button
                              onClick={() => resend(r.id)}
                              className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                              data-testid={`cockpit-requests-resend-${r.id}`}
                              title="Resend reminder to client"
                            >
                              <Send size={11} /> Resend
                            </button>
                            <button
                              onClick={() => cancel(r.id)}
                              className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                              data-testid={`cockpit-requests-cancel-${r.id}`}
                              title="Cancel this request"
                            >
                              <XCircle size={11} /> Cancel
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => nav(`/accounting/transactions?search=${encodeURIComponent(r.question || "")}&company=${r.company_id}`)}
                          className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                          data-testid={`cockpit-requests-view-${r.id}`}
                          title="View transaction"
                        >
                          View →
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
