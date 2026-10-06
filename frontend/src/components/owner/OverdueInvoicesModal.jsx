import React, { useState } from "react";
import { AlertTriangle, X, Check } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button, Pill, fmtDay, fmtWhole } from "./ui";

export function OverdueInvoicesModal({ companyId, invoices, fmt, onClose, onChanged }) {
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState({});
  const [dates, setDates] = useState(() => Object.fromEntries(invoices.map((i) => [i.id, i.expected_payment_date || ""])));
  const total = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  const saveDate = async (inv, d) => {
    setDates((p) => ({ ...p, [inv.id]: d }));
    if (!d || d === inv.expected_payment_date) return;
    try {
      await api.post(`/companies/${companyId}/projections/invoices/${inv.id}/expected-date`, { expected_payment_date: d });
      toast.success(`${inv.number} now expected ${fmtDay(d)} — forecast updated.`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save expected date."); }
  };

  const remind = async (inv) => {
    setSending(inv.id);
    try {
      await api.post(`/companies/${companyId}/communications/dunning`, { invoice_id: inv.id });
      setSent((p) => ({ ...p, [inv.id]: true }));
      toast.success(`Reminder sent for ${inv.number}.`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send reminder.");
    } finally { setSending(null); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="overdue-invoices-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{invoices.length} invoice{invoices.length > 1 ? "s" : ""} overdue · {fmtWhole(fmt, total)}</div>
            <h2 className="font-heading text-xl">Keep collections moving</h2>
            <p className="text-xs text-slate-500 mt-0.5">Know when a customer plans to pay? Set the expected date so the cash forecast reflects it — then send a nudge.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900" data-testid="overdue-invoices-close"><X size={16} /></button>
        </div>
        <div className="divide-y divide-slate-200">
          {invoices.map((inv) => (
            <div key={inv.id} className="flex flex-wrap items-center gap-3 py-3" data-testid={`overdue-invoice-row-${inv.id}`}>
              <span className="flex-none w-9 h-9 rounded-xl grid place-items-center bg-rose-50 text-rose-700 border border-rose-200"><AlertTriangle size={15} /></span>
              <div className="flex-1 min-w-[180px]">
                <div className="text-sm font-semibold truncate"><b>{inv.contact || "Customer"}</b> <span className="text-slate-500 font-normal">· {inv.number}</span></div>
                <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                  <span>Due {fmtDay(inv.due_date)}</span>
                  <Pill tone={inv.days_overdue > 30 ? "bad" : "warn"}>{inv.days_overdue} days overdue</Pill>
                </div>
              </div>
              <div className="font-mono-num text-sm font-semibold">{fmtWhole(fmt, inv.balance)}</div>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                Expected
                <input type="date" className="border rounded px-1.5 py-1 text-xs text-slate-800" value={dates[inv.id] || ""}
                  onChange={(e) => saveDate(inv, e.target.value)} data-testid={`overdue-invoice-expect-date-${inv.id}`} />
              </label>
              <Button primary disabled={sending === inv.id || sent[inv.id]} onClick={() => remind(inv)} data-testid={`overdue-invoice-remind-${inv.id}`}>
                {sent[inv.id] ? <span className="inline-flex items-center gap-1"><Check size={12} /> Sent</span> : sending === inv.id ? "Sending…" : "Send reminder"}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
