import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FileText, Plus, ChevronDown, Settings2, Check } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, PillFilter, TagsFilter, ListToolbar, ListHead, ListFooter, EmptyIllustration, HoverPill } from "@/components/practice/listParts";
import { fromISO } from "@/components/practice/DateTimePicker";

const COLS = ["Number", "Date", "Status", "Approval Date", "Approved By", "Total", "Balance", "Contact", "Matter"];
const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const Money = ({ v }) => <>{usd(v)} <span className="text-[10px] text-slate-500">USD</span></>;

const StatCard = ({ label, value, testId }) => (
  <div className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-3" data-testid={testId}>
    <span className="text-[11px] uppercase tracking-wider text-slate-600">{label}</span>
    <span className="text-xl text-slate-800">{usd(value)} <span className="text-[10px] text-slate-500">USD</span></span>
  </div>
);

export function InvoicesTable({ rows, nav, q, setQ, hideContact }) {
  const sumT = rows.reduce((a, r) => a + r.total, 0), sumB = rows.reduce((a, r) => a + r.balance, 0);
  return (
            <div data-testid="practice-invoices-table">
              <ListToolbar q={q} setQ={setQ} placeholder="Search Invoices..." testId="practice-invoices-search" />
              <table className="w-full text-sm">
                <ListHead cols={hideContact ? COLS.filter(c => c !== "Contact") : COLS} />
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="group relative border-t border-slate-200 hover:bg-slate-100" data-testid={`practice-invoice-row-${r.id}`}>
                      <td className="px-4 py-5"><input type="checkbox" className="h-4 w-4" /></td>
                      <td className="px-2 py-5 relative">
                        <button type="button" onClick={() => nav(`/practice/invoices/${r.id}`)} className="font-semibold text-[#1E88E5] hover:underline text-[15px]" data-testid={`practice-invoice-link-${r.id}`}>Invoice I-{r.number}</button>
                        <HoverPill testId={`practice-invoice-actions-${r.id}`}>
                          <button type="button" onClick={() => nav(`/practice/invoices/${r.id}/edit`)} className="hover:text-[#1E88E5]" data-testid={`practice-invoice-row-edit-${r.id}`}>Edit</button>
                          {["Approve", "Submit for Approval", "Enter Payment", "Mark as Sent", "Send", "PDF"].map(a => <span key={a}>{a}</span>)}
                          <button type="button" onClick={() => window.open(`/practice/invoices/${r.id}`, "_blank")} className="hover:text-[#1E88E5]">Print</button>
                        </HoverPill>
                      </td>
                      <td className="px-2 py-5 text-slate-700">{mdy(r.date)}</td>
                      <td className="px-2 py-5"><span className={`inline-flex items-center justify-center gap-1 min-w-[110px] rounded-full px-3 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider ${r.status === "Paid" ? "bg-[#43A047] text-white" : "border border-slate-400 bg-white text-slate-700"}`} data-testid={`practice-invoice-status-${r.id}`}>{r.status === "Paid" && <Check size={10} />}{r.status}</span></td>
                      <td className="px-2 py-5 text-slate-700">{r.status === "Paid" && r.last_payment_date ? mdy(r.last_payment_date) : ""}</td><td className="px-2 py-5" />
                      <td className="px-2 py-5 text-slate-700"><Money v={r.total} /></td>
                      <td className="px-2 py-5 text-slate-700"><Money v={r.balance} /></td>
                      {!hideContact && <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className="text-[#1E88E5] hover:underline">{r.contact_name}</button></td>}
                      <td className="px-2 py-5 space-x-2">{r.matters.map(m => <button key={m.id} type="button" onClick={() => nav(`/practice/matters/${m.id}`)} className="text-[#1E88E5] hover:underline">{m.name}</button>)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800" data-testid="practice-invoices-totals-row">
                    <td colSpan={6} /><td className="px-2 py-2"><Money v={sumT} /></td><td className="px-2 py-2"><Money v={sumB} /></td><td colSpan={hideContact ? 1 : 2} />
                  </tr>
                </tfoot>
              </table>
              <ListFooter count={rows.length} />
            </div>
  );
}

export default function PracticeInvoices() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("Any");
  useEffect(() => { api.get("/practice/invoices").then(r => setData(r.data)).catch(() => { setData({ rows: [], all: 0, due: 0, overdue: 0 }); toast.error("Could not load invoices"); }); }, []);
  const rows = (data?.rows || []).filter(r => status === "Any" || r.status === status)
    .filter(r => `I-${r.number} ${r.contact_name} ${r.matters.map(m => m.name).join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-invoices">
        <div className="flex items-center gap-3">
          <FileText size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Invoices</h1>
          <div className="flex-1" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50" data-testid="practice-invoices-manage-tax"><Settings2 size={14} /> Manage Sales Tax</button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]" data-testid="practice-invoices-new-btn"><Plus size={14} /> New <ChevronDown size={12} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-invoices-filters">
          <select className={`${sel} w-32`} defaultValue="All Invoices" data-testid="practice-invoices-type-filter"><option>All Invoices</option></select>
          <span>Assigned To</span><select className={`${sel} w-24`} defaultValue="Contact" data-testid="practice-invoices-assigned-type"><option>Contact</option><option>Matter</option></select>
          <UserFilter testId="practice-invoices-user-filter" />
          <TagsFilter testId="practice-invoices-tags-filter" />
          <PillFilter testId="practice-invoices-bill-date">Bill Date</PillFilter>
          <PillFilter testId="practice-invoices-range">All Time</PillFilter>
          <span>Status</span>
          <select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-invoices-status-filter"><option>Any</option><option>Saved</option><option>Sent</option><option>Paid</option></select>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <StatCard label="All" value={data?.all} testId="practice-invoices-card-all" />
          <StatCard label="Due" value={data?.due} testId="practice-invoices-card-due" />
          <StatCard label="Overdue" value={data?.overdue} testId="practice-invoices-card-overdue" />
        </div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {data === null ? <div className="p-8 text-sm text-slate-500">Loading…</div> : data.rows.length === 0 ? (
            <EmptyIllustration icon={FileText} testId="practice-invoices-empty">
              <p className="text-sm text-slate-700">No invoices yet.</p>
              <p className="text-sm text-slate-700">Use Invoice on a billable time entry to generate your first invoice.</p>
            </EmptyIllustration>
          ) : (
            <InvoicesTable rows={rows} nav={nav} q={q} setQ={setQ} />
          )}
        </div>
      </div>
    </PracticeShell>
  );
}
