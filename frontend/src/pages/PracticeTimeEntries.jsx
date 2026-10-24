import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Clock, Plus, Play } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, PillFilter, TagsFilter, ListToolbar, ListHead, ListFooter, EmptyIllustration } from "@/components/practice/listParts";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { toISO, fromISO } from "@/components/practice/DateTimePicker";
import { startOfWeek } from "@/components/practice/CalendarSidebar";

const COLS = ["Item", "Status", "Date", "Hrs.", "Rate", "Total", "Billed By", "Contact", "Matter"];
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const hrs = (h) => Number(h || 0).toFixed(2).replace(/\.00$/, "");
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };

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
  const load = () => api.get("/practice/time-entries/all").then(r => setRows(r.data)).catch(() => { setRows([]); toast.error("Could not load time entries"); });
  useEffect(() => { load(); }, []);

  const all = rows || [];
  const shown = all
    .filter(r => status === "Any" || (status === "Billable" ? r.billable : !r.billable))
    .filter(r => `${r.contact_name} ${r.matter_name} ${r.item} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  const now = new Date();
  const totals = {
    today: sumHours(all, now), week: sumHours(all, startOfWeek(now)),
    month: sumHours(all, new Date(now.getFullYear(), now.getMonth(), 1)), year: sumHours(all, new Date(now.getFullYear(), 0, 1)),
  };
  const sumH = shown.reduce((a, r) => a + (r.hours || 0), 0);
  const sumT = shown.reduce((a, r) => a + (r.billable ? r.total || 0 : 0), 0);

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-time-entries">
        <div className="flex items-center gap-3">
          <Clock size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Time Entries</h1>
          <div className="flex-1" />
          <button type="button" data-testid="practice-te-multiple-page-btn" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Plus size={14} /> Multiple Time Entries</button>
          <button type="button" onClick={() => setModal(true)} data-testid="practice-te-page-new-btn" className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]"><Plus size={14} /> New Time Entry</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-te-filters">
          <span>Billed By</span><UserFilter testId="practice-te-billed-by-filter" />
          <span>Status</span>
          <select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-te-status-filter"><option>Any</option><option>Billable</option><option>Non-Billable</option></select>
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
            <div data-testid="practice-te-table">
              <ListToolbar q={q} setQ={setQ} placeholder="Search Time Entries..." testId="practice-te-search" />
              <table className="w-full text-sm">
                <ListHead cols={COLS} sortCol="Date" />
                <tbody>
                  {shown.map(r => (
                    <tr key={r.id} className="border-t border-slate-200 hover:bg-slate-50 align-top" data-testid={`practice-te-row-${r.id}`}>
                      <td className="px-4 py-5"><input type="checkbox" className="h-4 w-4" /></td>
                      <td className="px-2 py-5 max-w-xs">
                        <div className="inline-flex items-center gap-1.5 font-semibold text-[#1E88E5] text-[15px]"><Play size={13} className="fill-[#1E88E5]" />{r.item || "Time"}</div>
                        <div className="text-xs text-slate-500 whitespace-pre-line line-clamp-2">{r.description}</div>
                      </td>
                      <td className="px-2 py-5">
                        <span className={`inline-block min-w-[110px] rounded-full px-3 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider text-white ${r.billable ? "bg-[#FFA726]" : "bg-slate-400"}`}>{r.billable ? "Billable" : "Non-Billable"}</span>
                      </td>
                      <td className="px-2 py-5 text-slate-700">{mdy(r.date)}</td>
                      <td className="px-2 py-5 text-slate-700">{hrs(r.hours)}</td>
                      <td className="px-2 py-5 text-slate-700">{usd(r.hourly_rate)}</td>
                      <td className="px-2 py-5 text-slate-700">{usd(r.billable ? r.total : 0)}</td>
                      <td className="px-2 py-5"><span className="text-[#1E88E5]">{r.billed_by}</span></td>
                      <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className="text-[#1E88E5] hover:underline">{r.contact_name}</button></td>
                      <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className="text-[#1E88E5] hover:underline">{r.matter_name}</button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800" data-testid="practice-te-totals-row">
                    <td colSpan={4} /><td className="px-2 py-2">{sumH.toFixed(2)}</td><td /><td className="px-2 py-2">{usd(sumT)} <span className="text-[10px] font-normal">USD</span></td><td colSpan={3} />
                  </tr>
                </tfoot>
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
