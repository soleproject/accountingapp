/**
 * QBO Reconciliation panel — Option C / Phase 1
 *
 * Fetches QBO's canonical report (P&L, BS, or Transaction List) via
 * /api/companies/{cid}/qbo/reports/latest and shows it side-by-side
 * with the number our own report engine computed.
 *
 * If no snapshot exists, offers a "Fetch official QBO report" button
 * that calls /reports/snapshot to pull one fresh from Intuit.
 *
 * Only renders when the company has an active QBO connection.
 */
import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import {
  RefreshCw, CheckCircle2, AlertTriangle, Loader2, ExternalLink,
} from "lucide-react";

/** Map local report kind → QBO report code. */
const KIND_TO_QBO = {
  "balance-sheet":    "BalanceSheet",
  "income-statement": "ProfitAndLoss",
};

/** Walk QBO's Rows tree flat, extracting every leaf line's label + total. */
function flattenQboRows(rows, out = [], depth = 0) {
  if (!rows) return out;
  const list = Array.isArray(rows.Row) ? rows.Row : (Array.isArray(rows) ? rows : []);
  for (const r of list) {
    // Section headers with a nested Rows key
    if (r.Rows) {
      const header = r.Header?.ColData?.[0]?.value;
      if (header) out.push({ label: header, value: null, header: true, depth });
      flattenQboRows(r.Rows, out, depth + 1);
      // Summary row (subtotal)
      if (r.Summary?.ColData) {
        const [lbl, val] = r.Summary.ColData;
        out.push({
          label: lbl?.value || "Total",
          value: parseFloat(val?.value || 0),
          summary: true,
          depth,
        });
      }
    } else if (r.ColData) {
      const [lbl, val] = r.ColData;
      out.push({
        label: lbl?.value || "",
        value: val?.value !== "" ? parseFloat(val?.value || 0) : null,
        depth,
      });
    }
  }
  return out;
}

/** Normalize a label for fuzzy match: lowercase, strip whitespace + punctuation. */
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Compare QBO totals vs our totals side by side. */
function ReconciliationTable({ qboRows, ourRows, fmt }) {
  const ourByLabel = useMemo(() => {
    const m = new Map();
    for (const r of ourRows) m.set(norm(r.label), r.value);
    return m;
  }, [ourRows]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
          <th className="text-left py-2">Line</th>
          <th className="text-right py-2 w-32">Official QBO</th>
          <th className="text-right py-2 w-32">Our report</th>
          <th className="text-right py-2 w-32">Δ Difference</th>
        </tr>
      </thead>
      <tbody>
        {qboRows.map((r, i) => {
          if (r.header) return (
            <tr key={i} className="bg-slate-50">
              <td colSpan={4} className="py-1.5 px-2 font-semibold text-slate-700 text-xs uppercase tracking-wide">
                {r.label}
              </td>
            </tr>
          );
          if (r.value === null) return (
            <tr key={i}><td className="py-1 px-2" style={{ paddingLeft: 8 + r.depth * 12 }}>{r.label}</td></tr>
          );
          const ourVal = ourByLabel.get(norm(r.label));
          const hasOurs = ourVal !== undefined && ourVal !== null;
          const diff = hasOurs ? Math.abs(r.value - ourVal) : null;
          const matches = hasOurs && diff < 0.01;
          return (
            <tr
              key={i}
              className={r.summary ? "border-t border-slate-200 font-semibold" : ""}
              data-testid={`recon-row-${i}`}
            >
              <td className="py-1.5 px-2" style={{ paddingLeft: 8 + r.depth * 12 }}>
                {r.label}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.value)}</td>
              <td className={"py-1.5 px-2 text-right tabular-nums " + (hasOurs ? "" : "text-slate-400")}>
                {hasOurs ? fmt(ourVal) : "—"}
              </td>
              <td className={
                "py-1.5 px-2 text-right tabular-nums " +
                (matches ? "text-emerald-600" : hasOurs ? "text-rose-600" : "text-slate-400")
              }>
                {hasOurs ? (matches ? "✓" : `Δ ${fmt(diff)}`) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function QboReconciliationPanel({ companyId, reportKind, basis, ourReport }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [qboStatus, setQboStatus] = useState(null);
  const fmt = useMoneyFmt();

  const qboReportName = KIND_TO_QBO[reportKind];
  const method = basis === "cash" ? "Cash" : "Accrual";

  // Check QBO connection status — hide panel entirely if not connected
  useEffect(() => {
    api.get(`/companies/${companyId}/qbo/status`)
      .then(r => setQboStatus(r.data?.connected ? "connected" : "disconnected"))
      .catch(() => setQboStatus("disconnected"));
  }, [companyId]);

  // Load latest snapshot when panel opens
  useEffect(() => {
    if (!open || !qboReportName) return;
    setLoading(true);
    setError(null);
    api.get(`/companies/${companyId}/qbo/reports/latest`, {
      params: { report_name: qboReportName, accounting_method: method },
    })
      .then(r => setSnapshot(r.data?.snapshot || null))
      .catch(e => setError(e?.response?.data?.detail || "Failed to load QBO snapshot"))
      .finally(() => setLoading(false));
  }, [open, companyId, qboReportName, method]);

  const fetchFresh = async () => {
    setLoading(true); setError(null);
    try {
      // For P&L pass full year-to-date range; for BS just end date
      const today = new Date().toISOString().slice(0, 10);
      const jan1 = today.slice(0, 4) + "-01-01";
      await api.post(`/companies/${companyId}/qbo/reports/snapshot`, null, {
        params: {
          start_date: jan1,
          end_date: today,
          accounting_method: method,
        },
      });
      const r = await api.get(`/companies/${companyId}/qbo/reports/latest`, {
        params: { report_name: qboReportName, accounting_method: method },
      });
      setSnapshot(r.data?.snapshot || null);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to fetch QBO report");
    } finally {
      setLoading(false);
    }
  };

  if (!qboReportName) return null;   // Only P&L + BS are supported today
  if (qboStatus !== "connected") return null;   // Hide if no QBO connection

  const qboFlat = snapshot?.payload ? flattenQboRows(snapshot.payload.Rows) : [];
  const ourFlat = ourReport ? flattenOurReport(ourReport, reportKind) : [];

  // Overall match indicator — compare Net Income (P&L) or Total Equity (BS)
  const matchStatus = (() => {
    if (!snapshot || !ourReport) return null;
    const key = reportKind === "balance-sheet" ? "totalequity" : "netincome";
    const qMap = new Map(qboFlat.filter(r => r.value != null).map(r => [norm(r.label), r.value]));
    const oMap = new Map(ourFlat.filter(r => r.value != null).map(r => [norm(r.label), r.value]));
    const q = qMap.get(key), o = oMap.get(key);
    if (q == null || o == null) return "partial";
    return Math.abs(q - o) < 0.01 ? "match" : "drift";
  })();

  return (
    <div
      data-testid="qbo-reconciliation-panel"
      className="mt-6 rounded-lg border border-slate-200 bg-white overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="recon-toggle"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition"
      >
        <div className="h-8 w-8 rounded-md bg-gradient-to-br from-emerald-500 to-cyan-600 grid place-items-center text-white">
          {matchStatus === "match" ? <CheckCircle2 size={16} /> : <ExternalLink size={16} />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-800">
            Compare with official QuickBooks Online report
          </div>
          <div className="text-xs text-slate-500">
            {matchStatus === "match" && "Numbers match QBO exactly."}
            {matchStatus === "drift" && "Some values differ — click to see line-by-line diff."}
            {matchStatus === "partial" && "Snapshot available. Click to compare."}
            {!snapshot && !loading && "Click to fetch QBO's canonical report and compare."}
          </div>
        </div>
        {matchStatus === "match" && (
          <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-800">
            ✓ Match
          </span>
        )}
        {matchStatus === "drift" && (
          <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800">
            <AlertTriangle size={12} className="inline mr-1" /> Drift
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-200 px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-slate-500">
              {snapshot ? (
                <>
                  Snapshot taken {new Date(snapshot.snapshot_at).toLocaleString()} ·
                  {" "}{snapshot.accounting_method} basis
                  {snapshot.start_date && ` · ${snapshot.start_date} → ${snapshot.end_date}`}
                </>
              ) : "No snapshot yet."}
            </div>
            <button
              onClick={fetchFresh}
              disabled={loading}
              data-testid="recon-refresh"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {snapshot ? "Refresh from QBO" : "Fetch official QBO report"}
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 mb-3">
              {error}
            </div>
          )}

          {snapshot && qboFlat.length > 0 && (
            <ReconciliationTable qboRows={qboFlat} ourRows={ourFlat} fmt={fmt} />
          )}
        </div>
      )}
    </div>
  );
}

/** Flatten our internal report shape to the same {label, value} form. */
function flattenOurReport(data, kind) {
  const out = [];
  const walk = (rows, depth = 0) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      out.push({ label: r.name || r.label, value: Number(r.balance ?? r.amount ?? 0), depth });
      if (Array.isArray(r.children)) walk(r.children, depth + 1);
    }
  };
  if (kind === "balance-sheet") {
    walk(data.assets, 0);
    walk(data.liabilities, 0);
    walk(data.equity, 0);
    if (data.total_assets != null) out.push({ label: "Total Assets", value: Number(data.total_assets) });
    if (data.total_liabilities != null) out.push({ label: "Total Liabilities", value: Number(data.total_liabilities) });
    if (data.total_equity != null) out.push({ label: "Total Equity", value: Number(data.total_equity) });
  } else if (kind === "income-statement") {
    walk(data.revenue, 0);
    walk(data.expenses, 0);
    if (data.total_revenue != null) out.push({ label: "Total Income", value: Number(data.total_revenue) });
    if (data.total_expenses != null) out.push({ label: "Total Expenses", value: Number(data.total_expenses) });
    if (data.net_income != null) out.push({ label: "Net Income", value: Number(data.net_income) });
  }
  return out;
}
