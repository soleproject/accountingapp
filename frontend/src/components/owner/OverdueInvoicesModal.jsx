import React, { useEffect, useState } from "react";
import { AlertTriangle, X, Check, ArrowLeft, Loader2, Mail } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button, Pill, fmtDay, fmtWhole } from "./ui";

function ReminderPreview({ companyId, inv, onBack, onSent }) {
  const [preview, setPreview] = useState(null);
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.get(`/companies/${companyId}/communications/dunning/preview`, { params: { invoice_id: inv.id } })
      .then((r) => { setPreview(r.data); setTo(r.data.to || ""); })
      .catch((e) => { toast.error(e?.response?.data?.detail || "Could not load the reminder."); onBack(); });
  }, [companyId, inv.id, onBack]);

  const send = async () => {
    if (!to) { toast.error("Add the customer's email first."); return; }
    setSending(true);
    try {
      await api.post(`/companies/${companyId}/communications/dunning`, { invoice_id: inv.id, to });
      toast.success(`Reminder sent for ${inv.number}.`);
      onSent(inv);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send reminder.");
    } finally { setSending(false); }
  };

  if (!preview) return <div className="py-10 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>;
  const lastSent = preview.last_reminder_sent_at ? new Date(preview.last_reminder_sent_at) : null;
  return (
    <div data-testid="reminder-preview">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 mb-3" data-testid="reminder-preview-back"><ArrowLeft size={12} /> All overdue invoices</button>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-4 py-3 space-y-1.5 text-xs border-b border-slate-200">
          <div className="flex items-center gap-2"><span className="w-14 text-slate-500">To</span>
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@email.com"
              className="flex-1 border rounded px-2 py-1 text-xs bg-white" data-testid="reminder-preview-to" /></div>
          <div className="flex items-center gap-2"><span className="w-14 text-slate-500">Subject</span><span className="font-semibold text-slate-900" data-testid="reminder-preview-subject">{preview.subject}</span></div>
          {lastSent && <div className="text-amber-700" data-testid="reminder-preview-last-sent">Last reminder sent {lastSent.toLocaleDateString("en-US", { month: "short", day: "numeric" })}{preview.last_reminder_to ? ` to ${preview.last_reminder_to}` : ""}.</div>}
        </div>
        <iframe title="Reminder preview" srcDoc={preview.html} sandbox="" className="w-full h-[360px] bg-white" data-testid="reminder-preview-body" />
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        <Button onClick={onBack} data-testid="reminder-preview-cancel">Cancel</Button>
        <Button primary disabled={sending || !to} onClick={send} data-testid="reminder-preview-send">
          <span className="inline-flex items-center gap-1.5"><Mail size={12} /> {sending ? "Sending…" : "Send reminder"}</span>
        </Button>
      </div>
    </div>
  );
}

export function OverdueInvoicesModal({ companyId, invoices, fmt, onClose, onChanged }) {
  const [previewing, setPreviewing] = useState(null);
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

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="overdue-invoices-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              {previewing ? `${previewing.contact || "Customer"} · ${previewing.number} · ${fmtWhole(fmt, previewing.balance)}` : `${invoices.length} invoice${invoices.length > 1 ? "s" : ""} overdue · ${fmtWhole(fmt, total)}`}
            </div>
            <h2 className="font-heading text-xl">{previewing ? "Review the reminder before it goes out" : "Keep collections moving"}</h2>
            {!previewing && <p className="text-xs text-slate-500 mt-0.5">Know when a customer plans to pay? Set the expected date so the cash forecast reflects it — then send a nudge.</p>}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900" data-testid="overdue-invoices-close"><X size={16} /></button>
        </div>
        {previewing ? (
          <ReminderPreview companyId={companyId} inv={previewing} onBack={() => setPreviewing(null)}
            onSent={(inv) => { setSent((p) => ({ ...p, [inv.id]: true })); setPreviewing(null); onChanged?.(); }} />
        ) : (
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
                <Button primary disabled={sent[inv.id]} onClick={() => setPreviewing(inv)} data-testid={`overdue-invoice-remind-${inv.id}`}>
                  {sent[inv.id] ? <span className="inline-flex items-center gap-1"><Check size={12} /> Sent</span> : "Send reminder"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
