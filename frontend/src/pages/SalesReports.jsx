import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import { BarChart3, Loader2, Download, TrendingUp, TrendingDown, Package, ShoppingCart, Users } from "lucide-react";

const startYtd = () => new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

// Sales and Purchases share almost identical shape, so we drive both from
// this single page with a top-level toggle. Deep-linkable via ?mode=purchases.
export default function SalesReports() {
  const { currentId } = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = searchParams.get("mode") === "purchases" ? "purchases" : "sales";
  const setMode = (m) => {
    const n = new URLSearchParams(searchParams);
    if (m === "sales") n.delete("mode"); else n.set("mode", m);
    setSearchParams(n, { replace: true });
  };
  const [tab, setTab] = useState("item"); // "item" | "category"
  const [start, setStart] = useState(startYtd());
  const [end, setEnd] = useState(today());
  const [data, setData] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(false);

  const kindLabel = mode === "purchases" ? "Purchases" : "Sales";
  const docLabel = mode === "purchases" ? "Bills" : "Invoices";
  const docCountKey = mode === "purchases" ? "bill_count" : "invoice_count";

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      // "vendor" is purchases-only. Guard so a mode swap doesn't leave
      // us on a nonsensical /sales-by-vendor URL.
      const effectiveTab = tab === "vendor" && mode !== "purchases" ? "item" : tab;
      const path = effectiveTab === "vendor"
        ? "spend-by-vendor"
        : `${mode === "purchases" ? "purchases" : "sales"}-by-${effectiveTab}`;
      const r = await api.get(`/companies/${currentId}/reports/${path}`, { params: { start, end } });
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load report");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, mode, tab, start, end]);

  // Reset tab when switching to Sales if user was on the vendor tab.
  useEffect(() => {
    if (mode === "sales" && tab === "vendor") setTab("item");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const maxAmt = useMemo(() => Math.max(1, ...(data.rows || []).map(r => r.amount)), [data.rows]);

  const exportCsv = () => {
    const rows = data.rows || [];
    let header; let body;
    if (tab === "vendor") {
      header = ["Vendor", "Amount", "Paid", "Outstanding", "Bills"];
      body = rows.map(r => [safe(r.vendor_name), r.amount, r.paid_amount, r.outstanding, r.bill_count]);
    } else if (tab === "item") {
      header = ["Item", "Category", "Quantity", "Amount", `${docLabel} count`];
      body = rows.map(r => [safe(r.item_name), safe(r.category), r.quantity, r.amount, r[docCountKey]]);
    } else {
      header = ["Category", "Amount", "Line count", `${docLabel} count`];
      body = rows.map(r => [safe(r.category), r.amount, r.item_count, r[docCountKey]]);
    }
    const csv = [header, ...body].map(row => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const filenameTab = tab === "vendor" ? "vendor" : tab;
    a.download = `${mode}-by-${filenameTab}-${start}-to-${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const barClass = mode === "purchases"
    ? (tab === "vendor" ? "bg-fuchsia-500" : tab === "item" ? "bg-orange-500" : "bg-rose-500")
    : (tab === "item" ? "bg-indigo-500" : "bg-emerald-500");

  return (
    <div className="space-y-4" data-testid="sales-reports-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight inline-flex items-center gap-2">
            <BarChart3 size={22} /> {kindLabel} Reports
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {mode === "purchases"
              ? "Where the money's going — rolled up by item or by expense category. Excludes drafts and voided bills."
              : "Revenue rolled up by item or by income category. Excludes draft and voided invoices."}
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-white p-1 text-xs" data-testid="report-mode-toggle">
          <button
            onClick={() => setMode("sales")}
            data-testid="report-mode-sales"
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1 ${mode === "sales" ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          ><TrendingUp size={12} /> Sales</button>
          <button
            onClick={() => setMode("purchases")}
            data-testid="report-mode-purchases"
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1 ${mode === "purchases" ? "bg-rose-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          ><TrendingDown size={12} /> Purchases</button>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="inline-flex rounded-lg border bg-white p-1 text-xs">
          <button
            onClick={() => setTab("item")}
            data-testid="sales-tab-item"
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1 ${tab === "item" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          ><Package size={12} /> By Item</button>
          <button
            onClick={() => setTab("category")}
            data-testid="sales-tab-category"
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1 ${tab === "category" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          ><ShoppingCart size={12} /> By Category</button>
          {mode === "purchases" && (
            <button
              onClick={() => setTab("vendor")}
              data-testid="sales-tab-vendor"
              className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1 ${tab === "vendor" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            ><Users size={12} /> By Vendor</button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-slate-500">From</label>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
                 className="border rounded px-2 py-1 text-xs" data-testid="sales-start" />
          <label className="text-slate-500">To</label>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
                 className="border rounded px-2 py-1 text-xs" data-testid="sales-end" />
          <button onClick={exportCsv} data-testid="sales-export-csv"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border hover:bg-slate-50">
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-50">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {kindLabel} by {tab === "vendor" ? "vendor" : tab === "item" ? "item" : "category"} · {start} → {end}
          </div>
          <div className="text-sm">
            <span className="text-slate-500">Total: </span>
            <span className="font-mono-num font-semibold text-slate-900" data-testid="sales-total">
              {fmtMoney(data.total || 0)}
            </span>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white text-xs uppercase text-slate-500 border-b">
            {tab === "vendor" ? (
              <tr>
                <th className="px-3 py-2 text-left">Vendor</th>
                <th className="px-3 py-2 text-right">Total spend</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
                <th className="px-3 py-2 text-center">Bills</th>
                <th className="px-3 py-2 text-left w-40">Share</th>
              </tr>
            ) : tab === "item" ? (
              <tr>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-center">{docLabel}</th>
                <th className="px-3 py-2 text-left w-40">Share</th>
              </tr>
            ) : (
              <tr>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-center">Line count</th>
                <th className="px-3 py-2 text-center">{docLabel}</th>
                <th className="px-3 py-2 text-left w-40">Share</th>
              </tr>
            )}
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>
            )}
            {!loading && (data.rows || []).map((r, i) => {
              const pct = data.total ? Math.round((r.amount / data.total) * 100) : 0;
              const barPct = Math.round((r.amount / maxAmt) * 100);
              return (
                <tr key={i} className="border-b hover:bg-slate-50" data-testid={`sales-row-${i}`}>
                  {tab === "vendor" ? (
                    <>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.vendor_name}</td>
                      <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(r.amount)}</td>
                      <td className="px-3 py-2 text-right font-mono-num text-emerald-700">{fmtMoney(r.paid_amount || 0)}</td>
                      <td className={`px-3 py-2 text-right font-mono-num ${r.outstanding > 0 ? "text-rose-700" : "text-slate-400"}`}>{fmtMoney(r.outstanding || 0)}</td>
                      <td className="px-3 py-2 text-center font-mono-num text-slate-500">{r.bill_count}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full ${barClass}`} style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono-num text-slate-500 w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                    </>
                  ) : tab === "item" ? (
                    <>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.item_name}</td>
                      <td className="px-3 py-2 text-slate-500 text-xs">{r.category || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2 text-right font-mono-num text-slate-600">{Number(r.quantity).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(r.amount)}</td>
                      <td className="px-3 py-2 text-center font-mono-num text-slate-500">{r[docCountKey]}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full ${barClass}`} style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono-num text-slate-500 w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.category}</td>
                      <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(r.amount)}</td>
                      <td className="px-3 py-2 text-center font-mono-num text-slate-500">{r.item_count}</td>
                      <td className="px-3 py-2 text-center font-mono-num text-slate-500">{r[docCountKey]}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full ${barClass}`} style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono-num text-slate-500 w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {!loading && !(data.rows || []).length && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-500 text-sm">
                {mode === "purchases"
                  ? "No bill activity in this range. Try widening the date window or record a few bills first."
                  : "No sales in this range. Try a wider date window or send a few invoices first."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function safe(v) { return v == null ? "" : v; }
