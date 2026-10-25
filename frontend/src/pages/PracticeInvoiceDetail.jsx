import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { FileText, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronDown, Settings2, Save, HandCoins, ArrowRightCircle } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { fromISO } from "@/components/practice/DateTimePicker";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const pill = "inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50";

function InvoiceDoc({ inv }) {
  const hours = inv.time_entries.reduce((a, t) => a + (t.hours || 0), 0);
  const sub = inv.time_entries.reduce((a, t) => a + (t.sub || 0), 0);
  return (
    <div className="mx-auto w-full max-w-[860px] py-10 px-6 text-[13px] text-slate-800" data-testid="practice-invoice-doc">
      <div className="flex justify-between">
        <div>
          <div className="text-3xl text-[#1E3A8A] font-light tracking-tight" data-testid="practice-invoice-firm">{inv.firm?.name}</div>
          <div className="mt-2 text-xs text-slate-600">{inv.firm?.email}</div>
          {inv.firm?.phone && <div className="text-xs text-slate-600">O: {inv.firm.phone}</div>}
        </div>
        <div className="text-right">
          <div className="text-3xl text-[#1E3A8A] font-light tracking-wide">INVOICE</div>
          <table className="mt-2 ml-auto border border-slate-800 text-xs">
            <tbody>
              <tr className="border-b border-slate-800"><td className="px-2 py-1 text-left">Number</td><td className="px-2 py-1 text-right" data-testid="practice-invoice-number">{inv.number}</td></tr>
              <tr className="border-b border-slate-800"><td className="px-2 py-1 text-left">Issue Date</td><td className="px-2 py-1 text-right">{mdy(inv.date)}</td></tr>
              <tr><td className="px-2 py-1 text-left">Due Date</td><td className="px-2 py-1 text-right">{mdy(inv.due_date)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-12">
        <div className="text-xl text-[#1E3A8A] font-light">Bill To:</div>
        <div className="mt-1" data-testid="practice-invoice-bill-to">{inv.contact_name}</div>
      </div>
      <div className="mt-12">
        <div className="text-base text-slate-700 font-light">Time Entries</div>
        <table className="w-full mt-2">
          <thead><tr className="bg-slate-100 text-slate-600 font-light"><th className="px-2 py-2 text-left font-normal">Time Entries</th><th className="px-2 py-2 text-left font-normal">Billed By</th><th className="px-2 py-2 text-right font-normal">Rate</th><th className="px-2 py-2 text-right font-normal">Hours</th><th className="px-2 py-2 text-right font-normal">Sub</th></tr></thead>
          <tbody>
            {inv.time_entries.map(t => (
              <tr key={t.id} className="border-b border-slate-200 align-top" data-testid={`practice-invoice-line-${t.id}`}>
                <td className="px-2 py-3"><div className="font-semibold">{t.item}</div><div>{mdy(t.date)}</div><div className="whitespace-pre-line">{t.description}</div></td>
                <td className="px-2 py-3">{t.billed_by}</td>
                <td className="px-2 py-3 text-right">{usd(t.rate)}</td>
                <td className="px-2 py-3 text-right">{Number(t.hours).toFixed(2)}</td>
                <td className="px-2 py-3 text-right">{usd(t.sub)}</td>
              </tr>
            ))}
            <tr className="font-semibold"><td colSpan={2} /><td className="px-2 py-3 text-right">Time Entries Total</td><td className="px-2 py-3 text-right">{hours.toFixed(2)}</td><td className="px-2 py-3 text-right">{usd(sub)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="mt-10 flex justify-end">
        <table className="w-[300px] bg-slate-100 text-xs" data-testid="practice-invoice-totals">
          <tbody>
            {[["Total (USD)", inv.total, true], ["Paid", inv.paid, false], ["Balance", inv.balance, true]].map(([l, v, b]) => (
              <tr key={l}><td className={`px-3 py-2 text-right ${b ? "font-bold" : ""}`}>{l}</td><td className={`px-3 py-1`}><div className={`bg-white px-2 py-1 text-right ${b ? "font-bold" : ""}`}>{usd(v)}</div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PracticeInvoiceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [inv, setInv] = useState(null);
  useEffect(() => { setInv(null); api.get(`/practice/invoices/${id}`).then(r => setInv(r.data)).catch(() => { toast.error("Invoice not found"); nav("/practice/invoices"); }); }, [id, nav]);
  const del = async () => {
    if (!window.confirm("Delete this invoice? Its time entries will become billable again.")) return;
    try { await api.delete(`/practice/invoices/${id}`); toast.success("Invoice deleted."); nav("/practice/invoices"); } catch { toast.error("Could not delete"); }
  };
  if (!inv) return <PracticeShell withRail={false}><div className="p-8 text-sm text-slate-500">Loading…</div></PracticeShell>;
  const label = `I-${inv.number}`;
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-3" data-testid="practice-invoice-detail">
        <div className="flex items-center gap-3">
          <FileText size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2" data-testid="practice-invoice-title">
            <button type="button" onClick={() => nav(`/practice/contacts/${inv.contact_id}`)} className="hover:text-[#1E88E5]">{inv.contact_name}</button>
            <span className="text-slate-300 font-light">|</span>
            {inv.matters.map(m => <button key={m.id} type="button" onClick={() => nav(`/practice/matters/${m.id}`)} className="hover:text-[#1E88E5]">{m.name}</button>)}
            <span className="text-slate-300 font-light">|</span>Invoice - {label}
          </h1>
          <button type="button" onClick={() => nav(`/practice/invoices/${id}/edit`)} className="text-[#1E88E5]" data-testid="practice-invoice-edit"><Pencil size={15} /></button>
          <button type="button" onClick={del} className="text-[#1E88E5]" data-testid="practice-invoice-delete"><Trash2 size={15} /></button>
          <div className="flex-1" />
          <button type="button" className={pill} data-testid="practice-invoice-enter-payment">Enter Payment <ArrowRightCircle size={14} /></button>
          <button type="button" className={`${pill} text-slate-400`} data-testid="practice-invoice-send">Send <ArrowRightCircle size={14} /></button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white" data-testid="practice-invoice-actions"><Settings2 size={14} /> Actions <ChevronDown size={12} /></button>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-6 items-center">
          <div className="flex items-center gap-3 rounded bg-[#E53935] px-4 py-2.5 text-white" data-testid="practice-invoice-due-card">
            <HandCoins size={26} />
            <div><div className="text-[10px] font-semibold uppercase tracking-wider">Due</div><div className="text-lg font-bold leading-tight">{usd(inv.balance)} <span className="text-[10px] font-normal">USD</span></div></div>
          </div>
          <div className="flex items-center gap-3 rounded bg-slate-400 px-4 py-2.5 text-white" data-testid="practice-invoice-status-card">
            <Save size={24} />
            <div><div className="text-[10px] font-semibold uppercase tracking-wider">Status</div><div className="text-sm font-semibold uppercase leading-tight">{inv.status}</div></div>
          </div>
          <div className="flex gap-3">
            <button type="button" disabled={!inv.prev_id} onClick={() => nav(`/practice/invoices/${inv.prev_id}`)} className={`${pill} w-24 justify-center disabled:opacity-40`} data-testid="practice-invoice-prev"><ChevronLeft size={16} /></button>
            <button type="button" disabled={!inv.next_id} onClick={() => nav(`/practice/invoices/${inv.next_id}`)} className={`${pill} w-24 justify-center disabled:opacity-40`} data-testid="practice-invoice-next"><ChevronRight size={16} /></button>
          </div>
        </div>
        <div className="rounded border border-slate-200 bg-white"><InvoiceDoc inv={inv} /></div>
        <button type="button" className="w-full rounded border border-slate-200 bg-white px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1" data-testid="practice-invoice-recent-activity">Recent Activity <ChevronRight size={14} /></button>
      </div>
    </PracticeShell>
  );
}
