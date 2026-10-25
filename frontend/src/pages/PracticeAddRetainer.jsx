import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Banknote, Check, X } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton, input as inp } from "@/components/practice/forms";
import { toISO } from "@/components/practice/DateTimePicker";
import { Section, L, Linked, useLinked } from "@/pages/PracticeWriteCheck";

export default function PracticeAddRetainer() {
  const nav = useNavigate();
  const { contact, matter, params } = useLinked();
  const [open, setOpen] = useState(0);
  const [f, setF] = useState({ amount: "", bank_account: "Operating Account", date: toISO(new Date()), payment_method: "Cash", notes: "", auto_apply: false });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));
  useEffect(() => {
    const c = params.get("contact"); if (!c) return;
    api.get("/practice/invoices", { params: { contact_id: c } }).then(r => setOpen(r.data.rows.filter(i => i.balance > 0).length)).catch(() => {});
  }, [params]);
  const trust = f.bank_account === "Trust Account";
  const save = async () => {
    if (!Number(f.amount)) return toast.error("Enter an amount.");
    try {
      await api.post("/practice/retainers", { ...f, amount: Number(f.amount), contact_id: contact?.id, matter_id: matter?.id || "", auto_apply: f.auto_apply && !trust });
      toast.success("Retainer added."); nav("/practice/payments");
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save retainer"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-add-retainer">
        <div className="flex items-center gap-3"><Banknote size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Add a Retainer</h1></div>
        {contact && <Linked contact={contact} matter={matter} nav={nav} />}
        <Section title="Payment Details" testId="practice-retainer-details">
          <L required help>Amount <span className="text-[10px] font-normal normal-case">(USD)</span></L><input type="number" step="0.01" className={inp} placeholder="Enter Amount..." value={f.amount} onChange={set("amount")} data-testid="practice-retainer-amount" />
          <L required>Bank Account</L><select className={inp} value={f.bank_account} onChange={set("bank_account")} data-testid="practice-retainer-account"><option>Operating Account</option><option>Trust Account</option></select>
          <L required>Date</L><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-retainer-date" />
          <L>Payment Method</L><select className={inp} value={f.payment_method} onChange={set("payment_method")} data-testid="practice-retainer-method"><option>Cash</option><option>Check</option><option>Credit / Debit Card</option><option>Bank Transfer</option><option>Other</option></select>
          <L>Notes</L><input className={inp} placeholder="Add Notes..." value={f.notes} onChange={set("notes")} data-testid="practice-retainer-notes" />
        </Section>
        {!trust && open > 0 && (
          <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid="practice-retainer-outstanding">
            <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-2">{open} Outstanding Invoice(s) Detected!</h2>
            <label className="flex items-center gap-2 text-[15px] text-slate-700"><span className="text-slate-400">?</span><input type="checkbox" className="h-4 w-4" checked={f.auto_apply} onChange={set("auto_apply")} data-testid="practice-retainer-auto-apply" />Click here if you would like this payment to automatically apply to your oldest outstanding invoices ( Does not apply to Trust Account)</label>
          </section>
        )}
        <div className="flex items-center gap-2">
          <GreenButton onClick={save} testId="practice-retainer-save"><Check size={14} /> Add Retainer</GreenButton>
          <button type="button" onClick={() => nav(-1)} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-retainer-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}
