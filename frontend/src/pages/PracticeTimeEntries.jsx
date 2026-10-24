import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Clock, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton } from "@/components/practice/forms";
import { ListToolbar, ListHead, ListFooter, EmptyIllustration, CountCard } from "@/components/practice/listParts";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

const COLS = ["Date", "Contact", "Matter", "Item", "Description", "Hours", "Rate", "Total", "Billed By"];
const fmtH = (h) => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return mm ? `${hh}h ${mm}m` : `${hh}h`; };
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function PracticeTimeEntries() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(false);
  const load = () => api.get("/practice/time-entries/all").then(r => setRows(r.data)).catch(() => { setRows([]); toast.error("Could not load time entries"); });
  useEffect(() => { load(); }, []);
  const shown = (rows || []).filter(r => `${r.contact_name} ${r.matter_name} ${r.item} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  const totalHours = shown.reduce((a, r) => a + (r.hours || 0), 0);
  const totalAmt = shown.reduce((a, r) => a + (r.total || 0), 0);

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-time-entries">
        <div className="flex items-center gap-3">
          <Clock size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Time Entries</h1>
          <div className="flex-1" />
          <GreenButton onClick={() => setModal(true)} testId="practice-te-page-new-btn"><Plus size={14} /> New</GreenButton>
        </div>
        {rows && rows.length > 0 && (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
            <CountCard label="Entries" value={shown.length} testId="practice-te-count" />
            <CountCard label="Hours" value={fmtH(totalHours)} testId="practice-te-hours-total" />
            <CountCard label="Billable Total" value={usd(totalAmt)} testId="practice-te-amount-total" />
          </div>
        )}
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div> : rows.length === 0 ? (
            <EmptyIllustration icon={Clock} testId="practice-te-empty">
              <p className="text-sm text-slate-700">Track your time against matters.</p>
              <p className="text-sm text-slate-700">Click the green "New" button or use Log Time on any task.</p>
            </EmptyIllustration>
          ) : (
            <div data-testid="practice-te-table">
              <ListToolbar q={q} setQ={setQ} placeholder="Search Time Entries..." testId="practice-te-search" />
              <table className="w-full text-sm">
                <ListHead cols={COLS} sortCol="Date" />
                <tbody>
                  {shown.map(r => (
                    <tr key={r.id} className="border-t border-slate-200 hover:bg-slate-50" data-testid={`practice-te-row-${r.id}`}>
                      <td className="px-4 py-3"><input type="checkbox" className="h-4 w-4" /></td>
                      <td className="px-2 py-3 text-slate-700">{r.date}</td>
                      <td className="px-2 py-3"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className="text-[#1E88E5] hover:underline">{r.contact_name}</button></td>
                      <td className="px-2 py-3"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className="text-[#1E88E5] hover:underline">{r.matter_name}</button></td>
                      <td className="px-2 py-3 text-slate-700">{r.item || "—"}</td>
                      <td className="px-2 py-3 text-slate-700 max-w-xs truncate" title={r.description}>{r.description?.split("\n")[0]}</td>
                      <td className="px-2 py-3 text-slate-700">{fmtH(r.hours)}</td>
                      <td className="px-2 py-3 text-slate-700">{usd(r.hourly_rate)}</td>
                      <td className="px-2 py-3 text-slate-700">{r.billable ? usd(r.total) : <span className="text-slate-400">non-billable</span>}</td>
                      <td className="px-2 py-3 text-slate-700">{r.billed_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ListFooter count={shown.length} />
            </div>
          )}
        </div>
      </div>
      {modal && <NewTimeEntryModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
    </PracticeShell>
  );
}
