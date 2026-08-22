import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Receipt, Search, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

// Refund Receipts — money paid back to a customer without a linked
// invoice. Symmetric counterpart to Sales Receipts (which are money
// IN without a linked invoice). Stored in `db.transactions` with
// `txn_type='RefundReceipt'`.
export default function RefundReceipts() {
  const { currentId } = useCompany();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api.get(`/companies/${currentId}/transactions?limit=1000`)
      .then((r) => {
        const all = r.data?.transactions || [];
        setRows(all.filter((t) => t.txn_type === "RefundReceipt"));
      })
      .catch(() => toast.error("Failed to load refund receipts"))
      .finally(() => setLoading(false));
  }, [currentId]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((t) =>
      [t.contact_name, t.number, t.memo, String(t.amount || "")]
        .filter(Boolean).join(" ").toLowerCase().includes(s)
    );
  }, [rows, q]);

  const total = visible.reduce((a, t) => a + Math.abs(Number(t.amount || 0)), 0);

  return (
    <div className="space-y-4" data-testid="refund-receipts-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Refund Receipts
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Money returned to customers without a linked invoice — DR
            revenue reversal, CR bank. The refund counterpart to Sales
            Receipts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="Search customer, memo, ref…"
                    className="pl-8 pr-3 py-1.5 rounded-md border text-sm w-64"
                    data-testid="refund-receipts-search" />
          </div>
          <Link to="/refund-receipts/new"
                 className="inline-flex items-center gap-1.5 px-3 py-1.5
                            rounded-md bg-slate-900 text-white text-xs"
                 data-testid="refund-receipts-new">
            <Plus className="w-3.5 h-3.5" /> New
          </Link>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide">Date</th>
              <th className="text-left px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide">Customer</th>
              <th className="text-left px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide">Ref #</th>
              <th className="text-left px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide">Memo</th>
              <th className="text-right px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide">Amount</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <Receipt className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                  <div className="text-slate-500 text-sm">No refund receipts yet.</div>
                </td>
              </tr>
            )}
            {visible.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{t.date}</td>
                <td className="px-4 py-2">{t.contact_name || "—"}</td>
                <td className="px-4 py-2 text-slate-600">
                  <Link to={`/refund-receipts/${t.id}/edit`}
                         className="text-indigo-600 hover:underline">
                    {t.number || "—"}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500 truncate max-w-md">{t.memo || ""}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  ${Math.abs(Number(t.amount || 0)).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
          {visible.length > 0 && (
            <tfoot>
              <tr className="border-t bg-slate-50">
                <td colSpan={4} className="px-4 py-2 text-right text-slate-600 font-medium">Total</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums font-medium">
                  ${total.toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
