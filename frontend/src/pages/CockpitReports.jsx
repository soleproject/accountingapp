import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  FileBarChart2, Download, Send, RefreshCw, CheckCircle2, Circle,
  ChevronLeft, ChevronRight, Sparkles, Loader2,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Reports (Advisor Reports Pack)
// Cross-client rollup: which clients have their monthly advisor report
// generated + sent for the target period. One-click generate & one-click
// send-to-portal per row. Bulk "Generate all missing" for the whole
// month.
// --------------------------------------------------------------------------

function currentYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function shift(y, m, delta) {
  const d = new Date(y, m - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function ymKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }
function ymLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export default function CockpitReports() {
  const location = useLocation();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => shift(currentYm().year, currentYm().month, -1));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyCid, setBusyCid] = useState(null);
  const [highlightCid, setHighlightCid] = useState(null);
  const rowRefs = useRef({});

  const period = ymKey(cursor.year, cursor.month);

  // Deep-link support: ?company=<cid>&period=YYYY-MM sets the cursor
  // and highlights the matching row. The Advisor-report agent finding
  // uses this so a partner lands on the exact client + month.
  useEffect(() => {
    const qp = new URLSearchParams(location.search);
    const p = qp.get("period");
    const cid = qp.get("company");
    if (p && /^\d{4}-\d{2}$/.test(p)) {
      setCursor({ year: Number(p.slice(0, 4)), month: Number(p.slice(5, 7)) });
    }
    if (cid) setHighlightCid(cid);
    if (p || cid) navigate(location.pathname, { replace: true });
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    if (!highlightCid || !rowRefs.current[highlightCid]) return;
    rowRefs.current[highlightCid].scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightCid(null), 4000);
    return () => clearTimeout(t);
  }, [highlightCid, data]);

  const load = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/cockpit/reports`, { params: { period } });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load reports.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [period]);

  const generate = async (cid, { regen = false, wasSent = false } = {}) => {
    if (regen) {
      const msg = wasSent
        ? "Regenerate this report? The prior version will be replaced and you'll need to send it to the client again."
        : "Regenerate this report with the latest ledger data? The prior version will be replaced.";
      if (!window.confirm(msg)) return;
    }
    setBusyCid(cid);
    try {
      const r = await api.post(`/companies/${cid}/advisor-reports/generate`, null, {
        params: { ym: period },
      });
      toast.success(
        regen
          ? `Report regenerated (${(r.data.size_bytes/1024).toFixed(0)}KB PDF).`
          : `Report generated (${(r.data.size_bytes/1024).toFixed(0)}KB PDF).`
      );
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Generate failed.");
    } finally {
      setBusyCid(null);
    }
  };

  const download = async (cid) => {
    try {
      const reports = await api.get(`/companies/${cid}/advisor-reports`);
      const r = (reports.data.reports || []).find((r) => r.period === period);
      if (!r) { toast.error("Report not found."); return; }
      const token = localStorage.getItem("axiom_token");
      const resp = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/companies/${cid}/advisor-reports/${r.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `advisor-${period}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error("Download failed.");
    }
  };

  const sendToPortal = async (cid) => {
    const email = window.prompt("Send report to which client email?");
    if (!email) return;
    setBusyCid(cid);
    try {
      const reports = await api.get(`/companies/${cid}/advisor-reports`);
      const r = (reports.data.reports || []).find((r) => r.period === period);
      if (!r) { toast.error("Generate the report first."); return; }
      await api.post(`/companies/${cid}/advisor-reports/${r.id}/send-to-portal`, null, {
        params: { to_email: email },
      });
      toast.success(`Sent to ${email}.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Send failed.");
    } finally {
      setBusyCid(null);
    }
  };

  const generateAll = async () => {
    if (!data?.per_company) return;
    const missing = data.per_company.filter((r) => !r.has_target_report);
    if (missing.length === 0) { toast.info("All reports generated."); return; }
    if (!window.confirm(`Generate ${missing.length} report${missing.length === 1 ? "" : "s"} for ${period}?`)) return;
    setBusy(true);
    for (const r of missing) {
      try { await api.post(`/companies/${r.company_id}/advisor-reports/generate`, null, { params: { ym: period } }); }
      catch (e) { /* keep going */ }
    }
    setBusy(false);
    toast.success("Bulk generate complete.");
    await load();
  };

  const totals = data?.totals || {};

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-reports-page">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Cockpit</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">Advisor Reports</h1>
          <p className="text-sm text-slate-500 mt-1">
            Branded monthly package per client — P&amp;L, Balance Sheet, KPIs, AI flux commentary.
            Delivered to the client portal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border border-slate-300 rounded-md bg-white">
            <button onClick={() => setCursor((c) => shift(c.year, c.month, -1))}
                    className="p-1.5 hover:bg-slate-50 border-r border-slate-200"
                    data-testid="cockpit-reports-prev">
              <ChevronLeft size={16} />
            </button>
            <div className="px-3 text-sm font-medium">{ymLabel(cursor.year, cursor.month)}</div>
            <button onClick={() => setCursor((c) => shift(c.year, c.month, 1))}
                    className="p-1.5 hover:bg-slate-50 border-l border-slate-200"
                    data-testid="cockpit-reports-next">
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            onClick={generateAll}
            disabled={busy || totals.pending === 0}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
            data-testid="cockpit-reports-generate-all"
          >
            <Sparkles size={14} />
            Generate {totals.pending || 0} missing
          </button>
          <button onClick={load} disabled={busy}
                  className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                  data-testid="cockpit-reports-refresh">
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-[10px] uppercase text-slate-500 font-semibold">Clients</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{totals.companies || 0}</div>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-[10px] uppercase text-emerald-700 font-semibold">Generated</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-800">{totals.generated || 0}</div>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="text-[10px] uppercase text-blue-700 font-semibold">Sent to client</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-blue-800">{totals.sent || 0}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-xs uppercase tracking-wide text-slate-600">
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2 w-32">Report</th>
              <th className="px-3 py-2 w-32">Sent to client</th>
              <th className="px-3 py-2 w-72 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.per_company || []).map((r) => (
              <tr key={r.company_id}
                  ref={(el) => { rowRefs.current[r.company_id] = el; }}
                  className={`border-b border-slate-100 hover:bg-slate-50/50 transition-colors ${highlightCid === r.company_id ? "bg-amber-50 ring-2 ring-amber-300" : ""}`}
                  data-testid={`cockpit-reports-row-${r.company_id}`}>
                <td className="px-3 py-2.5">
                  <div className="font-semibold text-slate-900">{r.company_name}</div>
                  <div className="text-[11px] text-slate-500">
                    {r.latest_period ? `Latest: ${r.latest_period}` : "No reports yet"}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {r.has_target_report ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                      <CheckCircle2 size={12} /> Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-500 text-xs">
                      <Circle size={12} /> Not generated
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {r.target_sent_at ? (
                    <span className="text-xs text-blue-700">
                      {new Date(r.target_sent_at).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    {!r.has_target_report && (
                      <button
                        onClick={() => generate(r.company_id)}
                        disabled={busyCid === r.company_id}
                        className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                        data-testid={`cockpit-reports-generate-${r.company_id}`}
                      >
                        {busyCid === r.company_id ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                        Generate
                      </button>
                    )}
                    {r.has_target_report && (
                      <>
                        <button
                          onClick={() => generate(r.company_id, { regen: true, wasSent: !!r.target_sent_at })}
                          disabled={busyCid === r.company_id}
                          title="Rebuild this report with the latest ledger data"
                          className="text-[11px] px-2 py-1 rounded border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 flex items-center gap-1"
                          data-testid={`cockpit-reports-regenerate-${r.company_id}`}
                        >
                          {busyCid === r.company_id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                          Regenerate
                        </button>
                        <button
                          onClick={() => download(r.company_id)}
                          className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                          data-testid={`cockpit-reports-download-${r.company_id}`}
                        >
                          <Download size={11} /> PDF
                        </button>
                        <button
                          onClick={() => sendToPortal(r.company_id)}
                          disabled={busyCid === r.company_id}
                          className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
                          data-testid={`cockpit-reports-send-${r.company_id}`}
                        >
                          <Send size={11} /> Send to portal
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
