import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Receipt, AlertTriangle, CheckCircle2, RefreshCw, FileText, Send,
  Eye, Download, ChevronRight,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → 1099 Cockpit
// Year-round vendor tax view. Cross-client rollup at the top; drill-in to
// any client shows the per-vendor table with W-9 chase + PDF preview.
// --------------------------------------------------------------------------

export default function Cockpit1099() {
  const nav = useNavigate();
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  const [summary, setSummary] = useState(null);
  const [selectedCompany, setSelectedCompany] = useState(null);
  const [vendors, setVendors] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadSummary = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/cockpit/1099/summary`, { params: { year } });
      setSummary(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load 1099 summary.");
      setSummary({ totals: {}, per_company: [] });
    } finally {
      setBusy(false);
    }
  };

  const loadVendors = async (cid) => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${cid}/1099/vendors`, { params: { year } });
      setVendors(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load vendors.");
      setVendors({ vendors: [] });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { loadSummary(); /* eslint-disable-next-line */ }, [year]);
  useEffect(() => { if (selectedCompany) loadVendors(selectedCompany.id); /* eslint-disable-next-line */ }, [selectedCompany, year]);

  const totals = summary?.totals || {};
  const threshold = summary?.threshold || 600;

  const requestW9 = async (cid, contactId, vendorName) => {
    try {
      await api.post(`/companies/${cid}/1099/vendors/${contactId}/request-w9`);
      toast.success(`W-9 request sent to ${vendorName}.`);
      loadVendors(cid);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to send W-9 request.");
    }
  };

  const downloadPdf = (cid, contactId, vendorName) => {
    const token = localStorage.getItem("axiom_token");
    const url = `${process.env.REACT_APP_BACKEND_URL}/api/companies/${cid}/1099/pdf/${contactId}?year=${year}`;
    // Use fetch to attach the auth header, then trigger a client-side download.
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `1099-NEC-${vendorName.replace(/\s+/g, "-")}-${year}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => toast.error("PDF download failed."));
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-1099-page">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Cockpit
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            1099 Cockpit
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Year-round view of every vendor tracking toward the ${threshold} threshold.
            Chase missing W-9s via the client portal — one workflow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="text-sm px-3 py-1.5 border border-slate-300 rounded-md bg-white"
            data-testid="cockpit-1099-year-select"
          >
            {[currentYear, currentYear - 1, currentYear - 2, currentYear - 3].map((y) => (
              <option key={y} value={y}>Tax Year {y}</option>
            ))}
          </select>
          <button
            onClick={loadSummary}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
            data-testid="cockpit-1099-refresh"
          >
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="cockpit-1099-summary">
        <SummaryCard
          testid="summary-needs"
          icon={FileText}
          label="Forms to file"
          value={totals.needs_1099 || 0}
          detail={`Over $${threshold} + flagged`}
          color="emerald"
        />
        <SummaryCard
          testid="summary-watch"
          icon={Receipt}
          label="On watch"
          value={totals.on_watch || 0}
          detail="Flagged, under threshold"
          color="amber"
        />
        <SummaryCard
          testid="summary-w9"
          icon={AlertTriangle}
          label="Missing W-9s"
          value={totals.missing_w9 || 0}
          detail="Chase before Jan 31"
          color="red"
        />
        <SummaryCard
          testid="summary-tin"
          icon={AlertTriangle}
          label="Missing TIN"
          value={totals.missing_tin || 0}
          detail="TIN required to file"
          color="red"
        />
      </div>

      {/* Two-pane: company list left, vendor table right */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* Company list */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="cockpit-1099-company-list">
          <div className="px-4 py-2 border-b border-slate-100 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            Clients with 1099 activity
          </div>
          {(summary?.per_company || []).length === 0 && (
            <div className="p-6 text-center text-sm text-slate-500">
              No 1099 activity across your clients yet.
              <div className="text-xs text-slate-400 mt-1">
                Flag a vendor as 1099-reportable in Contacts to start tracking.
              </div>
            </div>
          )}
          {(summary?.per_company || []).map((c) => {
            const active = selectedCompany?.id === c.company_id;
            return (
              <button
                key={c.company_id}
                onClick={() => setSelectedCompany({ id: c.company_id, name: c.company_name })}
                className={`w-full text-left px-4 py-2.5 border-b border-slate-100 hover:bg-slate-50 flex items-center justify-between gap-2 ${
                  active ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""
                }`}
                data-testid={`cockpit-1099-company-${c.company_id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900 truncate">{c.company_name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {c.needs_1099_count > 0 && <span className="text-emerald-600 mr-2">{c.needs_1099_count} to file</span>}
                    {c.on_watch_count > 0 && <span className="text-amber-600 mr-2">{c.on_watch_count} watch</span>}
                    {c.missing_w9_count > 0 && <span className="text-red-600">{c.missing_w9_count} no W-9</span>}
                  </div>
                </div>
                <ChevronRight size={14} className="text-slate-400 shrink-0" />
              </button>
            );
          })}
        </div>

        {/* Vendor table */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {!selectedCompany && (
            <div className="p-12 text-center" data-testid="cockpit-1099-select-prompt">
              <FileText className="mx-auto text-slate-300 mb-3" size={40} />
              <div className="text-slate-600 text-sm">
                Select a client on the left to see their 1099 vendors.
              </div>
            </div>
          )}

          {selectedCompany && (
            <>
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{selectedCompany.name}</div>
                  <div className="text-[11px] text-slate-500">
                    Tax Year {year} · {vendors?.count || 0} vendor{vendors?.count === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              {(vendors?.vendors || []).length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No 1099-tagged vendors yet for this year.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-600">
                      <th className="px-3 py-2">Vendor</th>
                      <th className="px-3 py-2 w-24 text-right">YTD Paid</th>
                      <th className="px-3 py-2 w-32">Status</th>
                      <th className="px-3 py-2 w-32">Issues</th>
                      <th className="px-3 py-2 w-56 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendors.vendors.map((v) => (
                      <VendorRow
                        key={v.contact_id}
                        v={v}
                        threshold={threshold}
                        onRequestW9={() => requestW9(selectedCompany.id, v.contact_id, v.vendor_name)}
                        onDownloadPdf={() => downloadPdf(selectedCompany.id, v.contact_id, v.vendor_name)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, detail, color, testid }) {
  const bg = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    amber:   "bg-amber-50 border-amber-200 text-amber-800",
    red:     "bg-red-50 border-red-200 text-red-800",
  }[color] || "bg-slate-50 border-slate-200 text-slate-800";
  return (
    <div className={`rounded-lg border p-4 ${bg}`} data-testid={`cockpit-1099-${testid}`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70">{label}</div>
        <Icon size={14} className="opacity-60" />
      </div>
      <div className="text-3xl font-bold mt-1 tabular-nums">{value}</div>
      <div className="text-[11px] opacity-70 mt-0.5">{detail}</div>
    </div>
  );
}

function VendorRow({ v, threshold, onRequestW9, onDownloadPdf }) {
  const statusColor =
    v.needs_1099 ? "bg-emerald-100 text-emerald-700"
    : v.on_watch ? "bg-amber-100 text-amber-700"
    : "bg-slate-100 text-slate-600";
  const statusLabel =
    v.needs_1099 ? "File 1099-NEC"
    : v.on_watch ? `Watch (need $${v.threshold_gap})`
    : "Under threshold";

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/50" data-testid={`cockpit-1099-vendor-row-${v.contact_id}`}>
      <td className="px-3 py-2.5">
        <div className="text-sm font-semibold text-slate-900">{v.vendor_name}</div>
        <div className="text-[11px] text-slate-500">{v.email || "no email on file"} · {v.txn_count} txn{v.txn_count === 1 ? "" : "s"}</div>
      </td>
      <td className="px-3 py-2.5 text-right font-mono-num text-sm">
        ${v.total_paid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-block text-[11px] px-2 py-0.5 rounded ${statusColor}`}>
          {statusLabel}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          {(v.issues || []).map((i) => (
            <span key={i} className="text-[10px] text-red-700">
              • {i.replace(/_/g, " ")}
            </span>
          ))}
          {v.w9_on_file && <span className="text-[10px] text-emerald-700">✓ W-9 on file</span>}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="inline-flex items-center gap-1">
          {!v.w9_on_file && v.email && (
            <button
              onClick={onRequestW9}
              className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
              data-testid={`cockpit-1099-request-w9-${v.contact_id}`}
              title="Send W-9 request via client portal"
            >
              <Send size={11} /> Request W-9
            </button>
          )}
          {v.needs_1099 && (
            <button
              onClick={onDownloadPdf}
              className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
              data-testid={`cockpit-1099-download-pdf-${v.contact_id}`}
              title="Download 1099-NEC preview PDF"
            >
              <Download size={11} /> 1099 PDF
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
