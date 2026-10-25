import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Banknote, Check, X, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton, Toggle, input as inp } from "@/components/practice/forms";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { toISO } from "@/components/practice/DateTimePicker";

const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const Section = ({ title, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid={testId}>
    <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">{title}</h2>
    <div className="grid grid-cols-[230px_minmax(0,480px)] gap-y-3 items-center">{children}</div>
  </section>
);
export const L = ({ children, required, help }) => <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 flex items-center gap-1">{help && <span className="text-slate-400">?</span>}{children}{required && <span className="text-red-500">*</span>}</div>;
export const Linked = ({ contact, matter, nav }) => (
  <Section title="Linked To" testId="practice-pay-linked">
    <L>Contact</L><div><button type="button" onClick={() => nav(`/practice/contacts/${contact.id}`)} className="text-[15px] text-[#1E88E5] hover:underline" data-testid="practice-pay-contact">{contact.name}</button></div>
    {matter && <><L>Matter</L><div><button type="button" onClick={() => nav(`/practice/matters/${matter.id}`)} className="text-[15px] text-[#1E88E5] hover:underline" data-testid="practice-pay-matter">{matter.name}</button></div></>}
  </Section>
);
export const useLinked = () => {
  const [params] = useSearchParams();
  const [contact, setContact] = useState(null);
  const [matter, setMatter] = useState(null);
  useEffect(() => {
    const c = params.get("contact"), m = params.get("matter");
    if (c) api.get(`/practice/contacts/${c}`).then(r => setContact({ id: c, name: r.data.display_name })).catch(() => {});
    if (m) api.get(`/practice/matters/${m}`).then(r => setMatter({ id: m, name: r.data.name })).catch(() => {});
  }, [params]);
  return { contact, matter, params };
};

export default function PracticeWriteCheck() {
  const nav = useNavigate();
  const { contact, matter } = useLinked();
  const [contacts, setContacts] = useState([]);
  const [f, setF] = useState({ amount: "", bank_account: "Operating Account", payment_method: "Check", date: toISO(new Date()), notes: "", payee: "", to_print: true });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  useEffect(() => { api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {}); }, []);
  useEffect(() => { if (contact && !f.payee) setF(p => ({ ...p, payee: contact.id })); }, [contact]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!Number(f.amount)) return toast.error("Enter an amount.");
    if (!f.payee) return toast.error("Select a payee.");
    try { await api.post("/practice/checks", { ...f, amount: Number(f.amount), contact_id: contact?.id, matter_id: matter?.id || "" }); toast.success("Check saved."); nav(-1); }
    catch (e) { toast.error(e?.response?.data?.detail || "Could not save"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-write-check">
        <div className="flex items-center gap-3"><Banknote size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Write a Check</h1></div>
        {contact && <Linked contact={contact} matter={matter} nav={nav} />}
        <Section title="Payment Details" testId="practice-check-details">
          <L required help>Amount</L><input type="number" step="0.01" className={inp} placeholder="Enter Amount..." value={f.amount} onChange={set("amount")} data-testid="practice-check-amount" />
          <L required help>Bank Account</L><select className={inp} value={f.bank_account} onChange={set("bank_account")} data-testid="practice-check-account"><option>Operating Account</option><option>Trust Account</option></select>
          <L>Payment Method</L><select className={inp} value={f.payment_method} onChange={set("payment_method")} data-testid="practice-check-method"><option>Check</option><option>Cash</option><option>Bank Transfer</option><option>Other</option></select>
          <L required>Date</L><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-check-date" />
          <L help>Notes</L><input className={inp} placeholder="Add Notes..." value={f.notes} onChange={set("notes")} data-testid="practice-check-notes" />
        </Section>
        <Section title="Check Details" testId="practice-check-check-details">
          <L required help>Payee</L><ContactPicker value={f.payee} onChange={set("payee")} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-check-payee" />
          <L help>To Print?</L><div><Toggle value={f.to_print} onChange={set("to_print")} testId="practice-check-to-print" /></div>
        </Section>
        <div className="flex items-center gap-2">
          <GreenButton onClick={save} testId="practice-check-save"><Check size={14} /> Save</GreenButton>
          <button type="button" onClick={() => nav(-1)} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-check-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}

export function AddPaymentPage() {
  const nav = useNavigate();
  const { contact, matter, params } = useLinked();
  const [invoices, setInvoices] = useState([]);
  const [f, setF] = useState({ date: toISO(new Date()), payment_method: "Cash", bank_account: "Operating Account", notes: "" });
  const [amts, setAmts] = useState({});
  const [dates, setDates] = useState({});
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  useEffect(() => {
    const c = params.get("contact"); if (!c) return;
    api.get("/practice/invoices", { params: { contact_id: c } }).then(r => setInvoices(r.data.rows.filter(i => i.balance > 0))).catch(() => {});
  }, [params]);
  const openSum = invoices.reduce((a, i) => a + i.balance, 0);
  const paySum = invoices.reduce((a, i) => a + (Number(amts[i.id]) || 0), 0);
  const pay = async () => {
    const applications = invoices.filter(i => Number(amts[i.id]) > 0).map(i => ({ invoice_id: i.id, amount: Number(amts[i.id]), applied_date: dates[i.id] || f.date }));
    if (!applications.length) return toast.error("Enter an amount to pay.");
    try { await api.post("/practice/payments", { ...f, contact_id: contact?.id, matter_id: matter?.id || "", applications }); toast.success("Payment applied."); nav(`/practice/invoices/${applications[0].invoice_id}`); }
    catch (e) { toast.error(e?.response?.data?.detail || "Could not save payment"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-add-payment">
        <div className="flex items-center gap-3"><Banknote size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Add a Payment</h1></div>
        {contact && <Linked contact={contact} matter={matter} nav={nav} />}
        <Section title="Payment Details" testId="practice-pay-details">
          <L required>Date</L><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-pay-date" />
          <L>Payment Method</L><select className={inp} value={f.payment_method} onChange={set("payment_method")} data-testid="practice-pay-method"><option>Cash</option><option>Check</option><option>Credit / Debit Card</option><option>Bank Transfer</option><option>Other</option></select>
          <L required>Bank Account</L><select className={inp} value={f.bank_account} onChange={set("bank_account")} data-testid="practice-pay-account"><option>Operating Account</option><option>Trust Account</option></select>
          <L>Notes</L><input className={inp} placeholder="Add Notes..." value={f.notes} onChange={set("notes")} data-testid="practice-pay-notes" />
        </Section>
        <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid="practice-pay-invoices">
          <div className="rounded border border-slate-200 p-4">
            <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-2">Invoices to Pay</h2>
            <table className="w-full text-[15px] text-slate-700">
              <thead><tr className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 text-left"><th className="py-2">Invoice</th><th className="py-2">Open Balance</th><th className="py-2"><span className="text-slate-400">?</span> Amount to Pay</th><th className="py-2">Last Applied Date</th><th className="py-2">Applied Date</th><th /></tr></thead>
              <tbody>
                {invoices.map((i, idx) => (
                  <tr key={i.id} className={idx % 2 ? "" : "bg-slate-50"} data-testid={`practice-pay-row-${i.id}`}>
                    <td className="py-3"><button type="button" onClick={() => nav(`/practice/invoices/${i.id}`)} className="text-[#1E88E5] hover:underline">Invoice I-{i.number}</button></td>
                    <td className="py-3">{Number(i.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                    <td className="py-3"><input type="number" step="0.01" className={`${inp} w-40`} value={amts[i.id] ?? ""} placeholder="0.00" onChange={e => setAmts(a => ({ ...a, [i.id]: e.target.value }))} data-testid={`practice-pay-amount-${i.id}`} /></td>
                    <td className="py-3">{i.last_payment_date || "-"}</td>
                    <td className="py-3"><input type="date" className={`${inp} w-44`} value={dates[i.id] || f.date} onChange={e => setDates(d => ({ ...d, [i.id]: e.target.value }))} data-testid={`practice-pay-applied-${i.id}`} /></td>
                    <td className="py-3 text-right"><button type="button" onClick={() => setAmts(a => ({ ...a, [i.id]: i.balance.toFixed(2) }))} className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50" data-testid={`practice-pay-all-${i.id}`}><Plus size={12} /> Pay all</button></td>
                  </tr>
                ))}
                {invoices.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-sm text-slate-500">No open invoices.</td></tr>}
              </tbody>
              <tfoot><tr className="border-t border-slate-300 font-semibold text-slate-800"><td /><td className="py-3" data-testid="practice-pay-open-total">{usd(openSum)} <span className="text-[10px] font-normal">USD</span></td><td className="py-3" data-testid="practice-pay-pay-total">{usd(paySum)} <span className="text-[10px] font-normal">USD</span></td><td colSpan={3} /></tr></tfoot>
            </table>
          </div>
        </section>
        <div className="flex items-center gap-2">
          <GreenButton onClick={pay} testId="practice-pay-submit"><Check size={14} /> Pay Invoice(s)</GreenButton>
          <button type="button" onClick={() => nav(-1)} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-pay-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}
