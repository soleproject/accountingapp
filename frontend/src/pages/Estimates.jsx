/**
 * Estimates — list page. "New Estimate" and row clicks route to the
 * full-page EstimateEditor (parity with Invoices).
 */
import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import { Plus, FileText, ArrowRight, Trash2, Pencil } from "lucide-react";
import { Button } from "../components/ui/button";

const STATUS_TONES = {
  draft:     "bg-slate-100 text-slate-700",
  sent:      "bg-sky-100 text-sky-800",
  accepted:  "bg-emerald-100 text-emerald-800",
  rejected:  "bg-rose-100 text-rose-800",
  closed:    "bg-slate-200 text-slate-600",
  converted: "bg-indigo-100 text-indigo-800",
};

export default function Estimates() {
  const { currentId: cid } = useCompany();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${cid}/estimates`);
      setRows(r.data.estimates || []);
    } catch (e) {
      toast.error("Failed to load estimates");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [cid]);

  const convert = async (row) => {
    if (!window.confirm(`Convert ${row.number || "estimate"} to an invoice?`))
      return;
    try {
      const r = await api.post(
        `/companies/${cid}/estimates/${row.id}/convert`, {});
      toast.success("Invoice created");
      nav(`/invoices/${r.data.id}/edit`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Convert failed");
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete estimate ${row.number || row.id.slice(0,8)}?`))
      return;
    await api.delete(`/companies/${cid}/estimates/${row.id}`);
    toast.success("Deleted");
    load();
  };

  const listing = useMemo(() => rows.map(r => ({
    ...r,
    _statusPill: STATUS_TONES[r.status] || STATUS_TONES.draft,
  })), [rows]);

  return (
    <div className="space-y-6" data-testid="estimates-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">Estimates</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Quotes sent to customers before you invoice. Convert
            to an invoice with one click when accepted.
          </p>
        </div>
        <Button onClick={() => nav("/estimates/new")}
                data-testid="new-estimate-btn"
                className="gap-2">
          <Plus size={16} /> New Estimate
        </Button>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Number</th>
              <th className="text-left px-4 py-3">Customer</th>
              <th className="text-left px-4 py-3">Issued</th>
              <th className="text-left px-4 py-3">Expires</th>
              <th className="text-right px-4 py-3">Total</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                Loading…
              </td></tr>
            )}
            {!loading && listing.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                No estimates yet. Create your first quote to get started.
              </td></tr>
            )}
            {listing.map(r => (
              <tr
                key={r.id}
                onClick={() => nav(`/estimates/${r.id}/edit`)}
                className="hover:bg-slate-50 cursor-pointer"
                data-testid={`estimate-row-${r.id}`}
              >
                <td className="px-4 py-3 font-medium text-slate-800">
                  {r.number || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">{r.contact_name || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.issue_date || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.expiration_date || "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${Number(r.total || 0).toFixed(2)}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r._statusPill}`}>
                    {r.status || "draft"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => nav(`/estimates/${r.id}/edit`)}
                    data-testid={`edit-estimate-${r.id}`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                    <Pencil size={12} /> Edit
                  </button>
                  {r.status !== "converted" && (
                    <button
                      onClick={() => convert(r)}
                      data-testid={`convert-estimate-${r.id}`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100">
                      <ArrowRight size={12} /> Convert
                    </button>
                  )}
                  {r.status === "converted" && r.converted_invoice_id && (
                    <button
                      onClick={() => nav(`/invoices/${r.converted_invoice_id}/edit`)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                      <FileText size={12} /> View invoice
                    </button>
                  )}
                  <button
                    onClick={() => remove(r)}
                    data-testid={`delete-estimate-${r.id}`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-rose-200 bg-white text-rose-700 hover:bg-rose-50">
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
