import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Wallet, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, PillFilter, TagsFilter, ListToolbar, ListHead, ListFooter, EmptyIllustration, HoverPill } from "@/components/practice/listParts";
import { NewExpenseModal } from "@/components/practice/NewExpenseModal";
import { GenerateInvoiceModal } from "@/components/practice/GenerateInvoiceModal";
import { fromISO } from "@/components/practice/DateTimePicker";

const COLS = ["Expense", "Status", "Date", "Price", "Total", "Qty", "Contact", "Matter", "Billed By"];
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const link = "text-[#1E88E5] hover:underline";
const act = "hover:text-[#1E88E5]";

const StatCard = ({ label, value, testId }) => (
  <div className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-3" data-testid={testId}>
    <span className="text-[11px] uppercase tracking-wider text-slate-600">{label}</span>
    <span className="text-xl text-[#1E88E5]">{usd(value)}</span>
  </div>
);

export default function PracticeExpenses() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("Any");
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [invoiceFor, setInvoiceFor] = useState(null);
  const load = () => api.get("/practice/expenses").then(r => setRows(r.data)).catch(() => { setRows([]); toast.error("Could not load expenses"); });
  useEffect(() => { load(); }, []);
  const saved = () => toast.success("Item saved successfully.");
  const setStatus2 = async (r, st) => { try { await api.patch(`/practice/expenses/${r.id}/status`, { status: st }); saved(); load(); } catch { toast.error("Could not update"); } };
  const clone = async (r) => { try { await api.post(`/practice/expenses/${r.id}/clone`); saved(); load(); } catch { toast.error("Could not clone"); } };
  const del = async (r) => { if (!window.confirm("Delete this expense?")) return; try { await api.delete(`/practice/expenses/${r.id}`); toast.success("Expense deleted."); load(); } catch { toast.error("Could not delete"); } };

  const all = rows || [];
  const shown = all.filter(r => status === "Any" || r.billing_status === status)
    .filter(r => `${r.contact_name} ${r.matter_name} ${r.category} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  const sum = (list) => list.reduce((a, r) => a + (r.amount || 0), 0);
  const by = (st) => all.filter(r => r.billing_status === st);

  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-expenses">
        <div className="flex items-center gap-3">
          <Wallet size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Expenses</h1>
          <div className="flex-1" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50" data-testid="practice-exp-multiple-page-btn"><Plus size={14} /> Multiple Expenses</button>
          <button type="button" onClick={() => setModal(true)} className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]" data-testid="practice-exp-new-btn"><Plus size={14} /> New Expense</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-exp-filters">
          <span>Billed By</span><UserFilter testId="practice-exp-billed-by-filter" />
          <span>Status</span>
          <select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-exp-status-filter"><option>Any</option><option>Billable</option><option>Billed</option><option>Not Billable</option></select>
          <TagsFilter testId="practice-exp-tags-filter" />
          <span>Date Range</span><PillFilter testId="practice-exp-date-filter">All Time</PillFilter>
        </div>
        {all.length > 0 && (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
            <StatCard label="All" value={sum(all)} testId="practice-exp-card-all" />
            <StatCard label="Billable" value={sum(by("Billable"))} testId="practice-exp-card-billable" />
            <StatCard label="Billed" value={sum(by("Billed"))} testId="practice-exp-card-billed" />
            <StatCard label="Not Billable" value={sum(by("Not Billable"))} testId="practice-exp-card-not-billable" />
          </div>
        )}
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div> : rows.length === 0 ? (
            <EmptyIllustration icon={Wallet} testId="practice-exp-empty">
              <p className="text-sm text-slate-700">Track every billable or company expense.</p>
              <p className="text-sm text-slate-700">Click the green "New" button at the top to add an expense or read our <span className="text-[#1E88E5]">expenses tutorial</span>.</p>
            </EmptyIllustration>
          ) : (
            <div data-testid="practice-exp-table">
              <ListToolbar q={q} setQ={setQ} placeholder="Search Expenses..." testId="practice-exp-search" />
              <table className="w-full text-sm">
                <ListHead cols={COLS} sortCol="Date" />
                <tbody>
                  {shown.map(r => (
                    <tr key={r.id} className="group relative border-t border-slate-200 hover:bg-slate-100 align-top" data-testid={`practice-exp-row-${r.id}`}>
                      <td className="px-4 py-5"><input type="checkbox" className="h-4 w-4" /></td>
                      <td className="px-2 py-5 max-w-xs relative">
                        <button type="button" onClick={() => setEdit(r)} className="font-semibold text-[#1E88E5] hover:underline text-[15px]" data-testid={`practice-exp-link-${r.id}`}>{r.category || r.cost_type}</button>
                        <div className="text-xs text-slate-500 whitespace-pre-line line-clamp-2">{r.description}</div>
                        <HoverPill testId={`practice-exp-actions-${r.id}`}>
                          <button type="button" onClick={() => setEdit(r)} className={act} data-testid={`practice-exp-edit-${r.id}`}>Edit</button>
                          {r.billing_status === "Billable" && <button type="button" onClick={() => setInvoiceFor(r.contact_id)} className="text-[#1E88E5] hover:underline" data-testid={`practice-exp-invoice-${r.id}`}>Invoice</button>}
                          {r.billing_status !== "Billed" && <button type="button" onClick={() => setStatus2(r, "Billed")} className="text-[#43A047] hover:underline" data-testid={`practice-exp-billed-${r.id}`}>Billed</button>}
                          {r.billing_status !== "Billable" && <button type="button" onClick={() => setStatus2(r, "Billable")} className={act} data-testid={`practice-exp-billable-${r.id}`}>Billable</button>}
                          {r.billing_status !== "Not Billable" && <button type="button" onClick={() => setStatus2(r, "Not Billable")} className="text-[#1E88E5] hover:underline" data-testid={`practice-exp-notbillable-${r.id}`}>Not Billable</button>}
                          <button type="button" onClick={() => clone(r)} className={act} data-testid={`practice-exp-clone-${r.id}`}>Clone</button>
                          <button type="button" onClick={() => del(r)} className="hover:text-red-600" data-testid={`practice-exp-delete-${r.id}`}>Delete</button>
                        </HoverPill>
                      </td>
                      <td className="px-2 py-5">
                        <span data-testid={`practice-exp-status-${r.id}`} className={`inline-block min-w-[110px] rounded-full px-3 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider ${
                          r.billing_status === "Billed" ? "bg-[#43A047] text-white" : r.billing_status === "Not Billable" ? "border border-slate-400 bg-white text-slate-700" : "bg-[#FFA726] text-white"}`}>{r.billing_status}</span>
                      </td>
                      <td className="px-2 py-5 text-slate-700">{mdy(r.date)}</td>
                      <td className="px-2 py-5 text-slate-700">{usd(r.price)}</td>
                      <td className="px-2 py-5 text-slate-700">{usd(r.total)}</td>
                      <td className="px-2 py-5 text-slate-700">{Number(r.qty).toFixed(2).replace(/\.?0+$/, "")}</td>
                      <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className={link}>{r.contact_name}</button></td>
                      <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className={link}>{r.matter_name}</button></td>
                      <td className="px-2 py-5"><button type="button" onClick={() => nav("/practice/users/me")} className={link}>{r.billed_by}</button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800" data-testid="practice-exp-totals-row">
                    <td colSpan={5} /><td className="px-2 py-2">{usd(shown.reduce((a, r) => a + (r.total || 0), 0))} <span className="text-[10px] font-normal">USD</span></td><td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
              <ListFooter count={shown.length} />
            </div>
          )}
        </div>
      </div>
      {modal && <NewExpenseModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
      {edit && <NewExpenseModal expense={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {invoiceFor && <GenerateInvoiceModal contactId={invoiceFor} onClose={() => setInvoiceFor(null)} />}
    </PracticeShell>
  );
}
