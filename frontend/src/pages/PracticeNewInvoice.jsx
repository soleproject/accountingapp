import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { FileText, GripVertical, Pencil, Trash2, ChevronDown, Calendar, Check, Printer, Mail, CreditCard } from "lucide-react";
import { RichNotes } from "@/components/practice/RichNotes";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { Toggle, GreenButton } from "@/components/practice/forms";
import { fromISO } from "@/components/practice/DateTimePicker";

const inp = "w-full h-10 rounded border border-slate-300 bg-white px-3 text-[15px] text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const Label = ({ children, required, help }) => (
  <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 pt-2.5 flex items-start gap-1">{help && <span className="text-slate-400">?</span>}{children}{required && <span className="text-red-500">*</span>}</div>
);
const H = ({ children }) => <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800">{children}</h2>;
const LineTable = ({ title, cols, testId, addLabel }) => (
  <div data-testid={testId}>
    <H>{title}</H>
    <table className="w-full mt-2">
      <thead><tr className="border-b border-slate-200"><TH />{cols.map((c, i) => <TH key={c + i} right={i >= 2}>{c}</TH>)}</tr></thead>
      <tbody><tr><td colSpan={cols.length + 1} className="py-10 text-center text-sm text-slate-500">No rows</td></tr></tbody>
    </table>
    <button type="button" className="mt-4 inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid={`${testId}-add`}>{addLabel} <ChevronDown size={12} /></button>
  </div>
);
const TH = ({ children, right }) => <th className={`px-3 py-3 text-[13px] font-semibold uppercase tracking-wide text-slate-700 ${right ? "text-right" : "text-left"}`}>{children}</th>;

export default function PracticeNewInvoice() {
  const { id } = useParams();
  const nav = useNavigate();
  const [inv, setInv] = useState(null);
  useEffect(() => { api.get(`/practice/invoices/${id}`).then(r => setInv(r.data)).catch(() => { toast.error("Invoice not found"); nav("/practice/time-entries"); }); }, [id, nav]);
  const patch = async (data) => {
    setInv(p => { const n = { ...p, ...data }; const sub = n.time_entries.reduce((a, t) => a + (t.sub || 0), 0); n.total = +(sub * (1 - (n.discount || 0) / 100)).toFixed(2); n.balance = +(n.total - (n.paid || 0)).toFixed(2); return n; });
    try { await api.put(`/practice/invoices/${id}`, data); } catch { toast.error("Could not save"); }
  };
  const removeEntry = (eid) => patch({ time_entries: inv.time_entries.filter(t => t.id !== eid) });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { const r = await api.post(`/practice/invoices/${id}/save`, inv); toast.success("Invoice saved."); nav(`/practice/invoices/${r.data.id}`); }
    catch { toast.error("Could not save invoice"); } finally { setSaving(false); }
  };

  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-new-invoice">
        <div className="flex items-center gap-3">
          <FileText size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">New Invoice</h1>
        </div>
        {!inv ? <div className="p-8 text-sm text-slate-500">Loading…</div> : (
          <section className="rounded border border-slate-200 bg-white px-8 py-6 space-y-10">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-6">
              <div data-testid="practice-inv-linked">
                <H>Linked To</H>
                <div className="grid grid-cols-[230px_1fr] gap-y-3 mt-2">
                  <Label>Contact</Label><div className="pt-2.5"><button type="button" onClick={() => nav(`/practice/contacts/${inv.contact_id}`)} className="text-[15px] font-semibold text-[#1E88E5] hover:underline" data-testid="practice-inv-contact">{inv.contact_name}</button></div>
                  <Label>Matter</Label><div className="pt-2.5 space-x-2">{inv.matters.map(m => <button key={m.id} type="button" onClick={() => nav(`/practice/matters/${m.id}`)} className="text-[15px] font-semibold text-[#1E88E5] hover:underline" data-testid={`practice-inv-matter-${m.id}`}>{m.name}</button>)}</div>
                  <Label required>Template</Label>
                  <div className="relative"><select value={inv.template} onChange={e => patch({ template: e.target.value })} className={`${inp} appearance-none`} data-testid="practice-inv-template"><option>Default Invoice Template</option></select><ChevronDown size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none" /></div>
                  <Label help>Submit this invoice for approval?</Label><div className="pt-1"><Toggle value={!!inv.submit_for_approval} onChange={v => patch({ submit_for_approval: v })} testId="practice-inv-approval" /></div>
                </div>
              </div>
              <div data-testid="practice-inv-details">
                <H>Invoice</H>
                <div className="grid grid-cols-[230px_1fr] gap-y-3 mt-2">
                  <Label help>Number</Label><input type="number" value={inv.number ?? ""} onChange={e => patch({ number: e.target.value ? Number(e.target.value) : null })} placeholder="Number Generated on Save" className={inp} data-testid="practice-inv-number" />
                  <Label required>Date</Label><div className="relative"><input type="date" value={inv.date} onChange={e => patch({ date: e.target.value })} className={inp} data-testid="practice-inv-date" /><Calendar size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none bg-white" /></div>
                  <Label>Due Date</Label><div className="relative"><input type="date" value={inv.due_date} onChange={e => patch({ due_date: e.target.value })} className={inp} data-testid="practice-inv-due-date" /><Calendar size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none bg-white" /></div>
                  <Label help>Discount (%)</Label><input type="number" step="0.01" value={inv.discount} onChange={e => patch({ discount: Number(e.target.value) })} className={inp} data-testid="practice-inv-discount" />
                </div>
              </div>
            </div>

            <div data-testid="practice-inv-time-entries">
              <H>Time Entries</H>
              <table className="w-full mt-2">
                <thead><tr className="border-b-2 border-slate-800"><TH /><TH>Time Entries</TH><TH>Description</TH><TH right>Date</TH><TH right>Billed By</TH><TH right>Hours</TH><TH right>Rate</TH><TH right>Sub</TH><TH right>Tax</TH><TH right>Tax</TH></tr></thead>
                <tbody>
                  {inv.time_entries.map((t, i) => (
                    <tr key={t.id} className={`text-[15px] text-slate-700 ${i % 2 ? "" : "bg-slate-50"}`} data-testid={`practice-inv-te-row-${t.id}`}>
                      <td className="px-3 py-5 whitespace-nowrap"><span className="inline-flex items-center gap-2 text-slate-500"><GripVertical size={14} /><Pencil size={13} /><button type="button" onClick={() => removeEntry(t.id)} data-testid={`practice-inv-te-remove-${t.id}`} className="hover:text-red-600"><Trash2 size={13} /></button></span></td>
                      <td className="px-3 py-5">{t.item}</td>
                      <td className="px-3 py-5 whitespace-pre-line">{t.description}</td>
                      <td className="px-3 py-5 text-right whitespace-nowrap">{mdy(t.date)}</td>
                      <td className="px-3 py-5 text-right whitespace-nowrap">{t.billed_by}</td>
                      <td className="px-3 py-5 text-right">{Number(t.hours).toFixed(2).replace(/\.?0+$/, "")}</td>
                      <td className="px-3 py-5 text-right">{usd(t.rate)}</td>
                      <td className="px-3 py-5 text-right">{usd(t.sub)}</td>
                      <td className="px-3 py-5" /><td className="px-3 py-5" />
                    </tr>
                  ))}
                  {inv.time_entries.length === 0 && <tr><td colSpan={10} className="py-8 text-center text-sm text-slate-500">No rows</td></tr>}
                </tbody>
              </table>
              <button type="button" className="mt-4 inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-inv-add-time-entry">+ Time Entry <ChevronDown size={12} /></button>
            </div>

            <LineTable title="Expenses" cols={["Expenses", "Description", "Date", "Billed By", "Qty", "Price", "Sub", "Tax", "Tax"]} testId="practice-inv-expenses" addLabel="+ Expense" />
            <LineTable title="Flat Fees" cols={["Flat Fees", "Description", "Date", "Billed By", "Qty", "Price", "Sub", "Tax", "Tax"]} testId="practice-inv-flat-fees" addLabel="+ Flat Fee" />

            <div className="flex justify-end" data-testid="practice-inv-totals">
              <table className="w-[620px] text-[15px] text-slate-700 border border-slate-200">
                <tbody>
                  <tr className="border-b border-slate-200"><td className="px-4 py-2 text-right">Total (USD):</td><td className="px-4 py-2 text-right w-40" data-testid="practice-inv-total">{usd(inv.total)}</td></tr>
                  <tr className="border-b border-slate-200"><td className="px-4 py-2 text-right">Paid to Date:</td><td className="px-4 py-2 text-right" data-testid="practice-inv-paid">{usd(inv.paid)}</td></tr>
                  <tr className="bg-slate-100 font-bold text-slate-800"><td className="px-4 py-2 text-right">Balance Due:</td><td className="px-4 py-2 text-right" data-testid="practice-inv-balance">{usd(inv.balance)}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
        {inv && (
          <section className="rounded border border-slate-200 bg-white px-8 py-6 space-y-8" data-testid="practice-inv-notes-section">
            <H>Notes, Terms &amp; Conditions</H>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-6">
              <div className="grid grid-cols-[230px_1fr] gap-4"><Label help>Notes</Label><RichNotes value={inv.notes || ""} onChange={v => patch({ notes: v })} placeholder="" testId="practice-inv-notes" minHeight={180} /></div>
              <div className="grid grid-cols-[230px_1fr] gap-4"><Label>Terms &amp; Conditions</Label><RichNotes value={inv.terms || ""} onChange={v => patch({ terms: v })} placeholder="" testId="practice-inv-terms" minHeight={180} /></div>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-6">
              <div data-testid="practice-inv-payment-options">
                <H>Payment Options</H>
                <button type="button" className="text-xs text-[#1E88E5] hover:underline" data-testid="practice-inv-default-options">Click here to change the default options</button>
                <div className="grid grid-cols-[230px_1fr] gap-y-3 mt-2">
                  <Label help>Use operating account balance to pay this invoice?</Label><div className="pt-1"><Toggle value={!!inv.pay_operating} onChange={v => patch({ pay_operating: v })} testId="practice-inv-pay-operating" /></div>
                  <Label help>Use trust account balance to pay this invoice?</Label><div className="pt-1"><Toggle value={!!inv.pay_trust} onChange={v => patch({ pay_trust: v })} testId="practice-inv-pay-trust" /></div>
                  <Label help>Send invoice payment reminders?</Label><div className="pt-1"><Toggle value={!!inv.send_reminders} onChange={v => patch({ send_reminders: v })} testId="practice-inv-reminders" /></div>
                  <Label help>Add all unpaid balances to this invoice?</Label><div className="pt-1"><Toggle value={!!inv.add_unpaid} onChange={v => patch({ add_unpaid: v })} testId="practice-inv-add-unpaid" /></div>
                </div>
              </div>
              <div className="grid grid-cols-[230px_1fr] gap-y-6 pt-8" data-testid="practice-inv-online-payments">
                <Label>Accept Online Payments</Label>
                <div>
                  <div className="flex items-center gap-2 text-2xl font-bold text-[#1E3A8A]"><span className="h-9 w-9 rounded bg-[#1E88E5] grid place-items-center"><CreditCard size={20} className="text-white" /></span>Practice <span className="font-normal tracking-widest text-lg">PAYMENTS</span></div>
                  <div className="mt-2 flex gap-1.5">{["MC", "VISA", "AMEX", "DISC"].map(c => <span key={c} className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{c}</span>)}</div>
                  <p className="mt-2 text-xs text-slate-600">Accept credit card and eCheck</p>
                  <p className="text-xs text-[#1E88E5]">Learn why Practice Payments exceeds expectations</p>
                  <button type="button" className="mt-2 rounded-full bg-[#43A047] px-4 py-1 text-xs font-semibold text-white" data-testid="practice-inv-activate-payments">Activate for free</button>
                </div>
                <Label help>Add Interest?</Label><div><Toggle value={!!inv.add_interest} onChange={v => patch({ add_interest: v })} testId="practice-inv-add-interest" /></div>
              </div>
            </div>
          </section>
        )}
        {inv && (
          <div className="flex items-center gap-2" data-testid="practice-inv-actions">
            <GreenButton onClick={save} testId="practice-inv-save-btn" className={saving ? "opacity-60 pointer-events-none" : ""}><Check size={14} /> Save</GreenButton>
            <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-inv-print-btn"><Printer size={14} /> Print</button>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-inv-preview-email-btn"><Mail size={14} /> Preview email to client</button>
          </div>
        )}
      </div>
    </PracticeShell>
  );
}
