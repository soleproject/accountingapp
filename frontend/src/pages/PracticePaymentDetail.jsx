import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Banknote, Pencil, Trash2, ChevronDown, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { fromISO } from "@/components/practice/DateTimePicker";

const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Number(n || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso) => { if (!iso) return "-"; const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const Section = ({ title, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid={testId}>
    <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">{title}</h2>
    <dl className="grid grid-cols-[220px_1fr] gap-y-4 text-[15px]">{children}</dl>
  </section>
);
const Row = ({ label, sub, children }) => <><dt className="text-[13px] font-semibold uppercase tracking-wide text-slate-800">{label}{sub && <span className="ml-1 text-[11px] font-normal text-slate-500 normal-case">({sub})</span>}</dt><dd className="text-slate-700">{children}</dd></>;
const Link = ({ onClick, children, testId }) => <button type="button" onClick={onClick} className="text-[#1E88E5] hover:underline" data-testid={testId}>{children}</button>;

export default function PracticePaymentDetail() {
  const { src, id } = useParams();
  const nav = useNavigate();
  const [p, setP] = useState(null);
  useEffect(() => { api.get(`/practice/ledger/${src}/${id}`).then(r => setP(r.data)).catch(() => { toast.error("Payment not found"); nav("/practice/payments"); }); }, [src, id, nav]);
  const del = async () => {
    if (!window.confirm("Delete this payment? Any applied invoice balances will be restored.")) return;
    try { await api.delete(`/practice/ledger/${src}/${id}`); toast.success("Payment deleted."); nav("/practice/payments"); } catch { toast.error("Could not delete"); }
  };
  if (!p) return <PracticeShell withRail={false}><div className="p-8 text-sm text-slate-500">Loading…</div></PracticeShell>;
  const kind = p.type === "Payment" ? "Contact Payment" : p.type === "Check" ? "Firm Payment" : "Expense Payment";
  const neg = p.amount < 0, d = p.detail || {};
  const sumOpen = p.applications.reduce((a, x) => a + x.open_balance, 0), sumPay = p.applications.reduce((a, x) => a + x.amount, 0);
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-payment-detail">
        <div className="flex items-center gap-3">
          <Banknote size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2" data-testid="practice-payment-title">
            <button type="button" onClick={() => nav(`/practice/contacts/${p.contact_id}`)} className="hover:text-[#1E88E5]">{p.contact_name}</button>
            {p.matter_name && <><span className="text-slate-300 font-light">|</span><button type="button" onClick={() => nav(`/practice/matters/${p.matter_id}`)} className="hover:text-[#1E88E5]">{p.matter_name}</button></>}
            <span className="text-slate-300 font-light">|</span>{kind} - {p.ref}
          </h1>
          {p.src !== "payment" && <button type="button" onClick={() => nav(p.src === "check" ? "/practice/payments" : "/practice/expenses")} className="text-[#1E88E5]" data-testid="practice-payment-edit"><Pencil size={15} /></button>}
          <button type="button" onClick={del} className="text-[#1E88E5]" data-testid="practice-payment-delete"><Trash2 size={15} /></button>
          <div className="flex-1" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white"><Wrench size={14} /> Actions <ChevronDown size={12} /></button>
        </div>
        <div className={`inline-flex items-center gap-3 rounded px-4 py-2.5 text-white w-[450px] ${neg ? "bg-[#E53935]" : p.account === "Trust Account" ? "bg-[#1E88E5]" : "bg-[#43A047]"}`} data-testid="practice-payment-amount-card">
          <Banknote size={26} /><div><div className="text-[10px] font-semibold uppercase tracking-wider">Amount</div><div className="text-lg font-bold leading-tight">{usd(p.amount)} <span className="text-[10px] font-normal">USD</span></div></div>
        </div>
        <Section title="Linked To" testId="practice-payment-linked">
          <Row label="Contact"><Link onClick={() => nav(`/practice/contacts/${p.contact_id}`)}>{p.contact_name}</Link></Row>
          {p.matter_name && <Row label="Matter"><Link onClick={() => nav(`/practice/matters/${p.matter_id}`)}>{p.matter_name}</Link></Row>}
          {p.payee_name && <Row label="Payee"><Link onClick={() => nav(`/practice/contacts/${p.payee}`)}>{p.payee_name}</Link></Row>}
        </Section>
        <Section title="Payment Details" testId="practice-payment-details">
          <Row label="Bank Account"><Link onClick={() => nav(`/practice/payments/reconciliation?account=${encodeURIComponent(p.account)}`)}>{p.account}</Link></Row>
          <Row label="Date">{mdy(p.date)} 12:00 AM</Row>
          <Row label="Amount" sub="USD">{usd(Math.abs(p.amount))}</Row>
          <Row label="Payment Method">{p.method}</Row>
          {p.notes && <Row label="Notes">{p.notes}</Row>}
          {p.check_no && <Row label="Check No.">{p.check_no}</Row>}
          <Row label="Reconciled">{p.reconciled ? "Yes" : "No"}</Row>
        </Section>
        {p.src === "payment" && p.applications.length > 0 && (
          <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid="practice-payment-invoices">
            <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Linked Invoices</h2>
            <table className="w-full text-[15px] text-slate-700">
              <thead><tr className="text-left text-[13px] font-semibold uppercase tracking-wide text-slate-800"><th className="py-2">Invoice</th><th className="py-2">Open Balance</th><th className="py-2">Payment</th><th className="py-2">Applied Date</th></tr></thead>
              <tbody>{p.applications.map(a => (
                <tr key={a.invoice_id} className="bg-slate-50" data-testid={`practice-payment-app-${a.invoice_id}`}>
                  <td className="py-3"><Link onClick={() => nav(`/practice/invoices/${a.invoice_id}`)}>Invoice I-{a.number}</Link></td>
                  <td className="py-3">{Number(a.open_balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                  <td className="py-3">{Number(a.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                  <td className="py-3">{mdy(a.applied_date)}</td>
                </tr>))}</tbody>
              <tfoot><tr className="border-t border-slate-300 font-semibold text-slate-800"><td /><td className="py-3">{usd(sumOpen)} <span className="text-[10px] font-normal">USD</span></td><td className="py-3">{usd(sumPay)} <span className="text-[10px] font-normal">USD</span></td><td /></tr></tfoot>
            </table>
          </section>
        )}
        {p.src === "payment" && <Section title="" testId="practice-payment-paid"><Row label="Invoices Paid" sub="USD">{usd(sumPay)}</Row></Section>}
        {p.src === "expense" && <Section title="Expense" testId="practice-payment-expense"><Row label="Category">{d.category || "-"}</Row><Row label="Description">{d.description || "-"}</Row></Section>}
        <button type="button" className="w-full rounded border border-slate-200 bg-white px-4 py-3 text-left text-lg font-bold uppercase tracking-wide text-slate-800 flex items-center gap-1" data-testid="practice-payment-history">History <ChevronDown size={16} /></button>
      </div>
    </PracticeShell>
  );
}
