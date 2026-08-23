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
  RefreshCw, CheckCircle2, AlertTriangle, Loader2, ExternalLink, Download,
} from "lucide-react";

/** Map local report kind → QBO report code. */
const KIND_TO_QBO = {
  "balance-sheet":    "BalanceSheet",
  "income-statement": "ProfitAndLoss",
};

/** Normalize a section name so QBO's "Income" ↔ our revenue rows tie
 *  cleanly. QBO uses different section headers by report type, and
 *  BS headers are UPPER-CASED with punctuation, so we canonicalise
 *  down to a small vocabulary: income / cogs / expense / asset /
 *  liability / equity. Anything unknown returns "" and won't scope. */
function normSection(label) {
  const s = (label || "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!s) return "";
  if (s === "income" || s.startsWith("other income")) return "income";
  if (s.startsWith("cost of goods")) return "cogs";
  if (s === "expenses" || s.startsWith("other expenses")) return "expense";
  if (s === "assets" || s.endsWith("assets") || s.startsWith("current assets") || s.startsWith("other current assets") || s.startsWith("fixed assets") || s === "bank accounts" || s === "accounts receivable") return "asset";
  if (s === "liabilities" || s.startsWith("liabilities and") || s.endsWith("liabilities") || s === "accounts payable" || s === "credit cards" || s.startsWith("current liabilities") || s.startsWith("longterm liabilities") || s.startsWith("other current liabilities")) return "liability";
  if (s === "equity") return "equity";
  return "";  // sub-header, fall through to parent scope
}

/** Walk QBO's Rows tree flat, extracting every leaf line's label + total.
 *  Each emitted row carries its `section` (income/cogs/expense/asset/
 *  liability/equity) so the recon table can match against OUR rows
 *  scoped by section too — otherwise QBO's "Plants and Soil" income
 *  account collides with our "Plants and Soil" expense account (Craig's
 *  Design & Landscaping has both) and the panel prints false drift. */
function flattenQboRows(rows, out = [], depth = 0, section = "") {
  if (!rows) return out;
  const list = Array.isArray(rows.Row) ? rows.Row : (Array.isArray(rows) ? rows : []);
  for (const r of list) {
    // Section headers with a nested Rows key
    if (r.Rows) {
      const header = r.Header?.ColData?.[0]?.value;
      // Only override `section` when the header maps to a known one
      // — sub-headers like "Job Materials" keep the parent's section
      // scope (expense stays expense; income stays income).
      const nextSection = normSection(header) || section;
      if (header) out.push({ label: header, value: null, header: true, depth, section: nextSection });
      flattenQboRows(r.Rows, out, depth + 1, nextSection);
      // Summary row (subtotal)
      if (r.Summary?.ColData) {
        const [lbl, val] = r.Summary.ColData;
        out.push({
          label: lbl?.value || "Total",
          value: parseFloat(val?.value || 0),
          summary: true,
          depth,
          section: nextSection,
        });
      }
    } else if (r.ColData) {
      const [lbl, val] = r.ColData;
      out.push({
        label: lbl?.value || "",
        value: val?.value !== "" ? parseFloat(val?.value || 0) : null,
        depth,
        section,
      });
    }
  }
  return out;
}

/** Normalize a label for fuzzy match: lowercase, strip whitespace + punctuation. */
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Compare QBO totals vs our totals side by side, scoped by section. */
/**
 * Build the CSV rows for the currently-rendered reconciliation
 * table. Uses the same section-scoped `lookup` closure the table
 * itself uses, so the exported file mirrors the on-screen data
 * exactly — including which QBO row matched which Axiom row.
 *
 * Header rows use `null` in the numeric columns; QBO section
 * headers ("ASSETS", "LIABILITIES") export as a single-cell label.
 */
function buildCsvRows(qboRows, lookup) {
  const rows = [];
  rows.push(["Section", "Line", "Depth", "Official QBO", "Our Report",
             "Difference", "Match"]);
  for (const r of qboRows) {
    if (r.header) {
      rows.push([r.label, "", "", "", "", "", ""]);
      continue;
    }
    if (r.value === null || r.value === undefined) {
      rows.push([r.section || "", r.label, r.depth, "", "", "", ""]);
      continue;
    }
    const ours = lookup(r.section, r.label);
    const has = ours !== undefined && ours !== null;
    const diff = has ? Math.abs(r.value - ours) : null;
    const matches = has && diff < 0.01;
    rows.push([
      r.section || "",
      r.label,
      r.depth,
      Number(r.value).toFixed(2),
      has ? Number(ours).toFixed(2) : "",
      has ? Number(diff).toFixed(2) : "",
      has ? (matches ? "MATCH" : "DRIFT") : "N/A",
    ]);
  }
  return rows;
}

/** RFC-4180 CSV: quote every cell, escape embedded quotes by
 *  doubling them, join with `,` and separate rows with CRLF so
 *  Excel opens the file without prompting. */
function rowsToCsv(rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

function triggerCsvDownload(csv, filename) {
  // Prepend UTF-8 BOM so Excel treats the file as UTF-8 by default.
  const blob = new Blob(["\ufeff" + csv],
                        { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ReconciliationTable({ qboRows, ourRows, fmt, onExport }) {
  // Key rows by `${section}::${normLabel}` so an income "Plants and
  // Soil" doesn't collide with an expense "Plants and Soil". Falls
  // back to plain label-only for rows that have no section context
  // (top-level totals like "Net Income", "Total Assets").
  const ourBy = useMemo(() => {
    const scoped = new Map();
    const bare = new Map();
    for (const r of ourRows) {
      const l = norm(r.label);
      if (r.section) scoped.set(`${r.section}::${l}`, r.value);
      // Only populate the bare map with the FIRST occurrence — later
      // duplicates keep their section-scoped identity via `scoped`.
      if (!bare.has(l)) bare.set(l, r.value);
    }
    return { scoped, bare };
  }, [ourRows]);

  const lookup = (section, label) => {
    const l = norm(label);
    if (section) {
      const v = ourBy.scoped.get(`${section}::${l}`);
      if (v !== undefined) return v;
    }
    return ourBy.bare.get(l);
  };

  // Register the current lookup with the parent so its Export CSV
  // button can produce a CSV that mirrors exactly what's on screen
  // (same section-scoped matching rules, same rows shown).
  useEffect(() => {
    if (onExport) onExport(() => buildCsvRows(qboRows, lookup));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qboRows, ourRows]);

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
          const ourVal = lookup(r.section, r.label);
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

export default function QboReconciliationPanel({ companyId, reportKind, basis, ourReport, startDate, endDate }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [qboStatus, setQboStatus] = useState(null);
  // Ref-style holder — the table registers a getter that returns
  // the CSV rows for the current on-screen match. We call it on
  // export so the file always reflects what the user sees, even
  // if they've toggled a fresh snapshot in and out.
  const [csvGetter, setCsvGetter] = useState(null);
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
      // For P&L, pass the report's actual date range so the QBO
      // snapshot spans the same period the user is looking at.
      // Otherwise the default (`2000-01-01 → 2099-12-31`, chosen
      // for BS so no legacy history is truncated) would produce
      // "lifetime" QBO totals while our side shows YTD, and the
      // reconciliation table looks like massive drift when the
      // real reports actually tie. Feb 28 2026.
      // BS stays on the default range because it's inherently
      // point-in-time — the `end_date` (=`as_of`) alone determines
      // the balance; opening the window all the way back to 2000
      // costs nothing and avoids truncating legacy books.
      const isPl = reportKind === "income-statement";
      const params = { accounting_method: method };
      if (isPl && startDate) params.start_date = startDate;
      if (isPl && endDate) params.end_date = endDate;
      await api.post(`/companies/${companyId}/qbo/reports/snapshot`, null, {
        params,
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

  // Auto-refresh the QBO snapshot when the report's date range or
  // basis changes AFTER the user has already opened a snapshot in
  // this session. Prevents the "silent stale" trap where a user
  // picks Last Quarter, sees the P&L update, and the Compare panel
  // still shows the previous YTD snapshot they took an hour ago.
  //
  // Guards:
  //   * Only fires if a snapshot exists (avoids auto-fetch on
  //     initial page load — user must have manually pulled once).
  //   * Only fires if the panel is open (out-of-sight = no wasted
  //     QBO API calls).
  //   * Skipped while another refresh is in-flight.
  //
  // Must sit ABOVE the early `return null` guards below — React
  // hooks are order-sensitive and can't be called conditionally.
  //
  // Feb 28 2026.
  useEffect(() => {
    if (!open || !snapshot || loading) return;
    const snapStart = snapshot.start_date || "";
    const snapEnd = snapshot.end_date || "";
    const snapMethod = snapshot.accounting_method || "";
    const isPl = reportKind === "income-statement";
    const startChanged = isPl && startDate && snapStart && snapStart !== startDate;
    const endChanged = endDate && snapEnd && snapEnd !== endDate;
    const methodChanged = snapMethod && snapMethod !== method;
    if (startChanged || endChanged || methodChanged) {
      fetchFresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, method, open]);

  // Memoize the flattened row arrays so their references stay stable
  // across parent re-renders. The child `ReconciliationTable`'s
  // `useEffect([qboRows, ourRows])` fires on every render otherwise
  // (new array on every parent render), its `setCsvGetter(() => getter)`
  // triggers another parent re-render, and the loop saturates React's
  // scheduler — sidebar clicks update the URL but the route never
  // unmounts. MUST sit above the `return null` guards below so the
  // hook call order is stable. Feb 28 2026.
  const qboFlatMemo = useMemo(
    () => (snapshot?.payload ? flattenQboRows(snapshot.payload.Rows) : []),
    [snapshot],
  );
  const ourFlatMemo = useMemo(
    () => (ourReport ? flattenOurReport(ourReport, reportKind) : []),
    [ourReport, reportKind],
  );

  if (!qboReportName) return null;   // Only P&L + BS are supported today
  if (qboStatus !== "connected") return null;   // Hide if no QBO connection

  const qboFlat = qboFlatMemo;
  const ourFlat = ourFlatMemo;

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
            <div className="flex items-center gap-2">
              {snapshot && csvGetter && (
                <button
                  onClick={() => {
                    const rows = csvGetter();
                    const kindLabel = reportKind === "balance-sheet"
                      ? "balance-sheet" : "profit-and-loss";
                    const stamp = (snapshot.snapshot_at || "")
                      .slice(0, 10) || new Date().toISOString().slice(0, 10);
                    const filename =
                      `axiom-vs-qbo_${kindLabel}_${method.toLowerCase()}_${stamp}.csv`;
                    triggerCsvDownload(rowsToCsv(rows), filename);
                  }}
                  data-testid="recon-export-csv"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  title="Download the current comparison as CSV"
                >
                  <Download size={12} />
                  Export CSV
                </button>
              )}
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
          </div>

          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 mb-3">
              {error}
            </div>
          )}

          {snapshot && qboFlat.length > 0 && (
            <ReconciliationTable
              qboRows={qboFlat}
              ourRows={ourFlat}
              fmt={fmt}
              onExport={(getter) => setCsvGetter(() => getter)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Flatten our internal report shape to the same {label, value, section}
 *  form so the recon table can match rows scoped by section. Without
 *  the `section` tag, income "Plants and Soil" collides with expense
 *  "Plants and Soil" in the ourBy lookup and the panel shows the
 *  wrong value. */
function flattenOurReport(data, kind) {
  const out = [];
  const walk = (rows, section, depth = 0) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      out.push({
        label: r.name || r.label,
        value: Number(r.balance ?? r.amount ?? 0),
        depth,
        section,
      });
      if (Array.isArray(r.children)) walk(r.children, section, depth + 1);
    }
  };
  if (kind === "balance-sheet") {
    walk(data.assets, "asset");
    walk(data.liabilities, "liability");
    walk(data.equity, "equity");
    if (data.total_assets != null) out.push({ label: "Total Assets", value: Number(data.total_assets) });
    if (data.total_liabilities != null) out.push({ label: "Total Liabilities", value: Number(data.total_liabilities) });
    if (data.total_equity != null) out.push({ label: "Total Equity", value: Number(data.total_equity) });
  } else if (kind === "income-statement") {
    walk(data.revenue, "income");
    walk(data.cogs, "cogs");
    walk(data.expenses, "expense");
    if (data.total_revenue != null) out.push({ label: "Total Income", value: Number(data.total_revenue) });
    if (data.total_expenses != null) out.push({ label: "Total Expenses", value: Number(data.total_expenses) });
    if (data.net_income != null) out.push({ label: "Net Income", value: Number(data.net_income) });
  }
  return out;
}
