import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MatchDot } from "@/components/MatchDot";

/**
 * Shared list component for txn_type-scoped ledgers — currently
 * powers `/sales-receipts` and `/credit-memos`. Both live in the
 * `transactions` collection filtered by `txn_type`, so they share
 * 95% of their UI (row shape, load flow, delete flow, empty state).
 *
 * Kept as an internal shared component rather than a config table
 * so the individual list pages stay tweakable without pushing every
 * bespoke UX decision back into the shared surface.
 */
export default function TxnTypeListPage({
  entityType,       // "SalesReceipt" | "CreditMemo"
  title,            // "Sales Receipts"
  subtitle,         // human-readable explainer
  newButtonLabel,   // "New Sales Receipt"
  newRoute,         // "/sales-receipts/new"
  editRoutePrefix,  // "/sales-receipts"
  testIdPrefix,     // "sales-receipts"
  showLinkedInvoice, // boolean — true only for CreditMemo
  showMatchStatus = false, // boolean — true for entities with a cash leg
  contactLabel = "Customer",
  emptyHint,        // helper text for empty state
}) {
  const fmtMoney = useMoneyFmt();
  const { currentId: cid } = useCompany();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = async () => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${cid}/transactions`, {
        params: { txn_type: entityType, limit: 500, include_matched: true },
      });
      setRows(r.data.transactions || []);
    } catch (e) {
      toast.error(`Failed to load ${title.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cid]);

  const remove = async (row) => {
    if (!window.confirm(
      `Delete ${row.number || row.id.slice(0, 8)}? This also removes it from QBO.`))
      return;
    try {
      await api.delete(`/companies/${cid}/transactions/${row.id}`);
      toast.success("Deleted");
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    }
  };

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter(r =>
      (r.number || "").toLowerCase().includes(needle)
      || (r.contact_name || "").toLowerCase().includes(needle)
      || (r.memo || "").toLowerCase().includes(needle)
      || (r.description || "").toLowerCase().includes(needle));
  }, [rows, q]);

  const totalAmount = useMemo(
    () => filtered.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0),
    [filtered],
  );

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-page`}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">
            {title}
          </h1>
          <p className="text-slate-500 mt-1 text-sm">{subtitle}</p>
        </div>
        <Button
          onClick={() => nav(newRoute)}
          data-testid={`${testIdPrefix}-new-btn`}
          className="gap-2"
        >
          <Plus size={16} /> {newButtonLabel}
        </Button>
      </div>

      {/* Toolbar: search + running totals */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search by number, ${contactLabel.toLowerCase()}, memo…`}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-md"
            data-testid={`${testIdPrefix}-search-input`}
          />
        </div>
        <div className="text-xs text-slate-500 tabular-nums">
          <span className="font-medium text-slate-700">{filtered.length}</span> shown
          {" · "}
          <span className="font-medium text-slate-700">{fmtMoney(totalAmount)}</span> total
        </div>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Number</th>
              <th className="text-left px-4 py-3">{contactLabel}</th>
              <th className="text-left px-4 py-3">Date</th>
              {showLinkedInvoice && (
                <th className="text-left px-4 py-3">Applies to</th>
              )}
              <th className="text-right px-4 py-3">Amount</th>
              {showMatchStatus && (
                <th className="text-left px-4 py-3">Bank match</th>
              )}
              <th className="text-center px-4 py-3">QBO</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={(showLinkedInvoice ? 1 : 0) + (showMatchStatus ? 1 : 0) + 6}
                    className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={(showLinkedInvoice ? 1 : 0) + (showMatchStatus ? 1 : 0) + 6}
                    className="px-4 py-12 text-center text-slate-400">
                  {emptyHint}
                </td>
              </tr>
            )}
            {filtered.map(r => (
              <tr
                key={r.id}
                onClick={() => nav(`${editRoutePrefix}/${r.id}/edit`)}
                className="hover:bg-slate-50 cursor-pointer"
                data-testid={`${testIdPrefix}-row-${r.id}`}
              >
                <td className="px-4 py-3 font-medium text-slate-800">
                  {r.number || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {r.contact_name || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3 text-slate-600">{r.date || "—"}</td>
                {showLinkedInvoice && (
                  <td className="px-4 py-3 text-slate-600">
                    {r.linked_invoice_id
                      ? <span className="text-indigo-700">Invoice</span>
                      : <span className="text-slate-400">—</span>}
                  </td>
                )}
                <td className="px-4 py-3 text-right tabular-nums font-medium">
                  {fmtMoney(Math.abs(Number(r.amount || 0)))}
                </td>
                {showMatchStatus && (
                  <td className="px-4 py-3">
                    <MatchDot row={r} />
                  </td>
                )}
                <td className="px-4 py-3 text-center">
                  {r.qbo_id ? (
                    <span
                      className="inline-block w-2 h-2 rounded-full bg-emerald-500"
                      title={`Mirrored to QBO (id ${r.qbo_id})`}
                    />
                  ) : (
                    <span
                      className="inline-block w-2 h-2 rounded-full bg-slate-300"
                      title="Not yet pushed to QBO"
                    />
                  )}
                </td>
                <td
                  className="px-4 py-3 text-right space-x-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => nav(`${editRoutePrefix}/${r.id}/edit`)}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    data-testid={`${testIdPrefix}-edit-${r.id}`}
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  <button
                    onClick={() => remove(r)}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                    data-testid={`${testIdPrefix}-delete-${r.id}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
