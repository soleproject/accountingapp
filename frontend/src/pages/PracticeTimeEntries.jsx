import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Clock, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, PillFilter, TagsFilter, EmptyIllustration } from "@/components/practice/listParts";
import { TimeEntriesTable } from "@/components/practice/tables";
import { Can } from "@/components/practice/perms";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { toISO } from "@/components/practice/DateTimePicker";
import { startOfWeek } from "@/components/practice/CalendarSidebar";


const StatCard = ({ label, value, testId }) => (
  <div className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-3" data-testid={testId}>
    <span className="text-[11px] uppercase tracking-wider text-slate-600">{label}</span>
    <span className="text-xl text-[#1E88E5]">{value}</span>
  </div>
);

function sumHours(rows, from) {
  const f = toISO(from);
  return rows.filter(r => r.date >= f).reduce((a, r) => a + (r.hours || 0), 0);
}

export default function PracticeTimeEntries() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("Any");
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const saved = () => toast.success("Item saved successfully.");
  const setStatus2 = async (r, st) => { try { await api.patch(`/practice/time-entries/${r.id}/status`, { status: st }); saved(); load(); } catch { toast.error("Could not update"); } };
  const clone = async (r) => { try { await api.post(`/practice/time-entries/${r.id}/clone`); saved(); load(); } catch { toast.error("Could not clone"); } };
  const load = () => api.get("/practice/time-entries/all").then(r => setRows(r.data)).catch(() => { setRows([]); toast.error("Could not load time entries"); });
  useEffect(() => { load(); }, []);

  const all = rows || [];
  const shown = all.filter(r => status === "Any" || r.billing_status === status);
  const now = new Date();
  const totals = {
    today: sumHours(all, now), week: sumHours(all, startOfWeek(now)),
    month: sumHours(all, new Date(now.getFullYear(), now.getMonth(), 1)), year: sumHours(all, new Date(now.getFullYear(), 0, 1)),
  };

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-time-entries">
        <div className="flex items-center gap-3">
          <Clock size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Time Entries</h1>
          <div className="flex-1" />
          <button type="button" data-testid="practice-te-multiple-page-btn" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Plus size={14} /> Multiple Time Entries</button>
          <Can feature="Time Entries" action="create"><button type="button" onClick={() => setModal(true)} data-testid="practice-te-page-new-btn" className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]"><Plus size={14} /> New Time Entry</button></Can>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-te-filters">
          <span>Billed By</span><UserFilter testId="practice-te-billed-by-filter" />
          <span>Status</span>
          <select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-te-status-filter"><option>Any</option><option>Billable</option><option>Billed</option><option>Not Billable</option></select>
          <TagsFilter testId="practice-te-tags-filter" />
          <span>Date Range</span><PillFilter testId="practice-te-date-filter">All Time</PillFilter>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
          <StatCard label="Hours Today" value={totals.today.toFixed(2)} testId="practice-te-hours-today" />
          <StatCard label="Hours This Week" value={totals.week.toFixed(2)} testId="practice-te-hours-week" />
          <StatCard label="Hours This Month" value={totals.month.toFixed(2)} testId="practice-te-hours-month" />
          <StatCard label="Hours This Year" value={totals.year.toFixed(2)} testId="practice-te-hours-year" />
        </div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div> : rows.length === 0 ? (
            <EmptyIllustration icon={Clock} testId="practice-te-empty">
              <p className="text-sm text-slate-700">Track your time against matters.</p>
              <p className="text-sm text-slate-700">Click the green "New Time Entry" button or use Log Time on any task.</p>
            </EmptyIllustration>
          ) : (
            <TimeEntriesTable rows={shown} nav={nav} q={q} setQ={setQ} onEdit={setEdit} onStatus={setStatus2} onClone={clone} />
          )}
        </div>
      </div>
      {modal && <NewTimeEntryModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
      {edit && <NewTimeEntryModal entry={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </PracticeShell>
  );
}
