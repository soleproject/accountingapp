/**
 * OverdueBillsTile
 *
 * Inline expandable content for the "Paying bills" row on the
 * Responsibilities panel. Mirrors OverdueInvoicesTile but for AP
 * side — Number / Vendor / Due / Total / Balance / Status +
 * per-row Pay / Edit / Delete actions.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, Pencil, Trash2, DollarSign, ExternalLink, X, Plus, BellOff,
} from "lucide-react";
import { PaymentModal } from "@/pages/Payments";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";

const STATUS_TONES = {
  draft:      "bg-slate-100 text-slate-700 border-slate-200",
  open:       "bg-blue-100 text-blue-800 border-blue-200",
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

export default function OverdueBillsTile({ companyId, returnPath, returnLabel }) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [snoozing, setSnoozing] = useState(null);
  const [payingBill, setPayingBill] = useState(null); // { id, number, contact_id }
  const [modalCtx, setModalCtx] = useState({ contacts: [], transactions: [] });

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
      const r = await api.get(`/companies/${companyId}/responsibilities/overdue-bills`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load overdue bills.");
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  // Prefetch contacts + unmatched transactions on demand when the user
  // opens the Record Payment modal for the first time. Cached so the
  // subsequent bills reuse the same lists.
  const openPayModal = async (bill) => {
    if (!modalCtx.contacts.length) {
      try {
        const [cRes, tRes] = await Promise.all([
          api.get(`/companies/${companyId}/contacts`),
          api.get(`/companies/${companyId}/transactions`, { params: { has_je: false, limit: 200 } }).catch(() => ({ data: { transactions: [] } })),
        ]);
        setModalCtx({
          contacts: cRes.data?.contacts || cRes.data || [],
          transactions: tRes.data?.transactions || [],
        });
      } catch {
        setModalCtx({ contacts: [], transactions: [] });
      }
    }
    setPayingBill(bill);
  };

  const deleteBill = async (bill) => {
    if (!window.confirm(`Delete bill ${bill.number}? This cannot be undone.`)) return;
    setDeleting(bill.id);
    try {
      await api.delete(`/companies/${companyId}/bills/${bill.id}`);
      toast.success(`Deleted ${bill.number}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  const snoozeBill = async (bill, until, reason) => {
    setSnoozing(bill.id);
    try {
      await api.post(`/companies/${companyId}/bills/${bill.id}/cockpit-snooze`, {
        until, reason: reason || null,
      });
      const readable = new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      toast.success(`Snoozed ${bill.number} until ${readable}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Snooze failed");
    } finally {
      setSnoozing(null);
    }
  };

  if (busy && !data) {
    return (
      <div className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400" data-testid="overdue-bills-tile-loading">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  const bills = data?.bills || [];
  if (!bills.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500 space-y-2" data-testid="overdue-bills-tile-empty">
        <div>No bills past due — <b className="text-slate-800">nothing to pay</b>.</div>
        <Link
          to={buildHref(`/bills/new`)}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
          data-testid="overdue-bills-tile-create-empty"
        >
          <Plus size={11} /> Create bill
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="overdue-bills-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px]">
        <div className="text-slate-600">
          Showing <b>overdue</b> · {bills.length} of {data.total_open_count}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={buildHref(`/bills/new`)}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
            data-testid="overdue-bills-tile-create"
          >
            <Plus size={11} /> Create bill
          </Link>
          <Link
            to={buildHref(`/bills?filter=overdue`)}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            data-testid="overdue-bills-tile-clear"
          >
            <X size={11} /> Clear filters
          </Link>
          <button
            onClick={load}
            disabled={busy}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
            data-testid="overdue-bills-tile-refresh"
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
              <th className="text-left px-3 py-2 font-semibold">Vendor</th>
              <th className="text-left px-3 py-2 font-semibold">Due</th>
              <th className="text-right px-3 py-2 font-semibold">Total</th>
              <th className="text-right px-3 py-2 font-semibold">Balance</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-right px-3 py-2 font-semibold w-[110px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {bills.map(b => {
              const tone = STATUS_TONES[b.status] || STATUS_TONES.open;
              return (
                <tr key={b.id} className="hover:bg-slate-50" data-testid={`overdue-bill-row-${b.id}`}>
                  <td className="px-3 py-2 font-mono-num">
                    <Link
                      to={buildHref(`/bills/${b.id}/edit`)}
                      className="text-slate-900 hover:underline"
                    >
                      {b.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900 truncate max-w-[220px]">{b.vendor_name}</td>
                  <td className="px-3 py-2 text-slate-600 font-mono-num">{fmtDate(b.due_date)}</td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums">{fmtMoney(b.total)}</td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums text-slate-900">{fmtMoney(b.balance)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${tone}`}>
                      {b.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => openPayModal(b)}
                      title="Pay bill"
                      className="inline-flex text-emerald-600 hover:text-emerald-800 p-1"
                      data-testid={`overdue-pay-bill-${b.id}`}
                    >
                      <DollarSign size={13} />
                    </button>
                    <SnoozePopover
                      bill={b}
                      busy={snoozing === b.id}
                      onSnooze={(until, reason) => snoozeBill(b, until, reason)}
                    />
                    <Link
                      to={buildHref(`/bills/${b.id}/edit`)}
                      title="Edit"
                      className="inline-flex text-slate-500 hover:text-slate-800 p-1"
                      data-testid={`overdue-edit-bill-${b.id}`}
                    >
                      <Pencil size={13} />
                    </Link>
                    <button
                      onClick={() => deleteBill(b)}
                      disabled={deleting === b.id}
                      title="Delete"
                      className="text-red-500 hover:text-red-700 p-1 disabled:opacity-40"
                      data-testid={`overdue-delete-bill-${b.id}`}
                    >
                      {deleting === b.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
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
          to={buildHref("/bills?filter=overdue")}
          className="text-[11px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          data-testid="overdue-bills-open-all"
        >
          Open in Bills <ExternalLink size={10} />
        </Link>
      </div>
      {payingBill && (
        <PaymentModal
          currentId={companyId}
          contacts={modalCtx.contacts}
          invoices={[]}
          bills={data?.bills || []}
          transactions={modalCtx.transactions}
          preset={{
            kind: "bill",
            linkedId: payingBill.id,
            contactId: payingBill.vendor_id || "",
            docLabel: payingBill.number,
          }}
          onClose={() => {
            setPayingBill(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * SnoozePopover — quick-pick dismiss options for a bill in the cockpit.
 *
 * Renders a BellOff icon that opens a Radix Popover. The user picks
 * a preset window (1 day / 3 days / 1 week / 2 weeks / 1 month) OR a
 * custom date. On confirm, the parent posts to `/cockpit-snooze`.
 */
function SnoozePopover({ bill, busy, onSnooze }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");

  const addDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const PRESETS = [
    { label: "1 day",   until: addDays(1) },
    { label: "3 days",  until: addDays(3) },
    { label: "1 week",  until: addDays(7) },
    { label: "2 weeks", until: addDays(14) },
    { label: "1 month", until: addDays(30) },
  ];

  const submit = (until) => {
    if (!until) return;
    onSnooze(until, reason.trim() || null);
    setOpen(false);
    setCustom("");
    setReason("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title="Dismiss / snooze"
          className="inline-flex text-amber-600 hover:text-amber-800 p-1 disabled:opacity-40"
          disabled={busy}
          data-testid={`overdue-snooze-bill-${bill.id}`}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <BellOff size={13} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-2" data-testid={`snooze-popover-${bill.id}`}>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Dismiss until
          </div>
          <div className="text-xs text-slate-600 mt-0.5">
            How long until <b>{bill.number}</b> reappears in the cockpit + to-do?
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => submit(p.until)}
              className="text-[11px] px-2 py-1 rounded-full border border-slate-300 bg-white hover:bg-slate-100"
              data-testid={`snooze-preset-${p.label.replace(/\s/g, '-').toLowerCase()}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="pt-1 border-t space-y-1">
          <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Or pick a specific date
          </label>
          <input
            type="date"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="w-full text-xs border rounded px-2 py-1"
            data-testid={`snooze-custom-date-${bill.id}`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Reason (optional)
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. waiting on vendor credit"
            className="w-full text-xs border rounded px-2 py-1"
            data-testid={`snooze-reason-${bill.id}`}
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={() => { setOpen(false); setCustom(""); setReason(""); }}
            className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={() => submit(custom)}
            disabled={!custom}
            className="text-[11px] px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40"
            data-testid={`snooze-confirm-${bill.id}`}
          >
            Snooze
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

