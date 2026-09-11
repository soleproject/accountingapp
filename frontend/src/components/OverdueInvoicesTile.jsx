/**
 * OverdueInvoicesTile
 *
 * Inline expandable content for the "Following up with invoices" row
 * on the Responsibilities panel. Mirrors the ReconciliationAccountsTile
 * layout — slate header + one row per overdue invoice with Number,
 * Customer, Due, Total, Balance, Status pill, and per-row actions
 * (Send reminder / Edit / Delete).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, Pencil, Trash2, Send, ExternalLink, X, Plus,
} from "lucide-react";
import { AIFollowupModal } from "@/pages/Invoices";

const STATUS_TONES = {
  draft:      "bg-slate-100 text-slate-700 border-slate-200",
  sent:       "bg-blue-100 text-blue-800 border-blue-200",
  partial:    "bg-amber-100 text-amber-900 border-amber-200",
  overdue:    "bg-red-100 text-red-800 border-red-200",
  paid:       "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
};

export default function OverdueInvoicesTile({ companyId, returnPath, returnLabel }) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [showFollowupModal, setShowFollowupModal] = useState(false);

  const buildHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/responsibilities/overdue-invoices`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load overdue invoices.");
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const deleteInvoice = async (inv) => {
    if (!window.confirm(`Delete invoice ${inv.number}? This cannot be undone.`)) return;
    setDeleting(inv.id);
    try {
      await api.delete(`/companies/${companyId}/invoices/${inv.id}`);
      toast.success(`Deleted ${inv.number}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  if (busy && !data) {
    return (
      <div className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400" data-testid="overdue-invoices-tile-loading">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  const invoices = data?.invoices || [];
  if (!invoices.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500 space-y-2" data-testid="overdue-invoices-tile-empty">
        <div>No invoices past due — <b className="text-slate-800">inbox zero</b>.</div>
        <Link
          to={buildHref(`/invoices/new`)}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
          data-testid="overdue-invoices-tile-create-empty"
        >
          <Plus size={11} /> Create invoice
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="overdue-invoices-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px]">
        <div className="text-slate-600">
          Showing <b>overdue</b> · {invoices.length} of {data.total_open_count}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={buildHref(`/invoices/new`)}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
            data-testid="overdue-invoices-tile-create"
          >
            <Plus size={11} /> Create invoice
          </Link>
          <Link
            to={buildHref(`/invoices?filter=overdue`)}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            data-testid="overdue-invoices-tile-clear"
          >
            <X size={11} /> Clear filters
          </Link>
          <button
            onClick={load}
            disabled={busy}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
            data-testid="overdue-invoices-tile-refresh"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 bg-white border-b">
              <th className="text-left px-3 py-2 font-semibold">Number</th>
              <th className="text-left px-3 py-2 font-semibold">Customer</th>
              <th className="text-left px-3 py-2 font-semibold">Due</th>
              <th className="text-right px-3 py-2 font-semibold">Total</th>
              <th className="text-right px-3 py-2 font-semibold">Balance</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-right px-3 py-2 font-semibold w-[110px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoices.map(inv => {
              const tone = STATUS_TONES[inv.status] || STATUS_TONES.sent;
              return (
                <tr key={inv.id} className="hover:bg-slate-50" data-testid={`overdue-invoice-row-${inv.id}`}>
                  <td className="px-3 py-2 font-mono-num">
                    <Link
                      to={buildHref(`/invoices/${inv.id}`)}
                      className="text-slate-900 hover:underline"
                    >
                      {inv.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900 truncate max-w-[220px]">{inv.customer_name}</td>
                  <td className="px-3 py-2 text-slate-600 font-mono-num">{fmtDate(inv.due_date)}</td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums">{fmtMoney(inv.total)}</td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums text-slate-900">{fmtMoney(inv.balance)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${tone}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setShowFollowupModal(true)}
                      title="Draft AI follow-up email"
                      className="text-indigo-500 hover:text-indigo-700 p-1"
                      data-testid={`overdue-send-reminder-${inv.id}`}
                    >
                      <Send size={13} />
                    </button>
                    <Link
                      to={buildHref(`/invoices/${inv.id}/edit`)}
                      title="Edit"
                      className="inline-flex text-slate-500 hover:text-slate-800 p-1"
                      data-testid={`overdue-edit-${inv.id}`}
                    >
                      <Pencil size={13} />
                    </Link>
                    <button
                      onClick={() => deleteInvoice(inv)}
                      disabled={deleting === inv.id}
                      title="Delete"
                      className="text-red-500 hover:text-red-700 p-1 disabled:opacity-40"
                      data-testid={`overdue-delete-${inv.id}`}
                    >
                      {deleting === inv.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 border-t bg-slate-50 text-right">
        <Link
          to={buildHref("/invoices?filter=overdue")}
          className="text-[11px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          data-testid="overdue-invoices-open-all"
        >
          Open in Invoices <ExternalLink size={10} />
        </Link>
      </div>
      {showFollowupModal && (
        <AIFollowupModal
          currentId={companyId}
          onClose={() => {
            setShowFollowupModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}
