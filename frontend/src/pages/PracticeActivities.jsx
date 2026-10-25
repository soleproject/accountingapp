import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ListChecks, Upload, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, DateRangeFilter, inRange, TagsFilter } from "@/components/practice/listParts";
import { ActivitiesTable } from "@/components/practice/tables";
import { NewActivityMenu, ActivityModal } from "@/components/practice/ActivityModal";

const KIND_LABEL = { "": "All Activities", task: "Tasks", event: "Events", note: "Notes", call: "Calls" };
const actDate = (r) => r.kind === "event" ? r.start_date : r.due_date;
export const filterActivities = (rows, { status = "Any", assigned = "", range }) => rows
  .filter(r => status === "Any" || r.status === status)
  .filter(r => !assigned || (r.assigned_users || []).includes(assigned))
  .filter(r => inRange(actDate(r), range));
const white = "inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50";
const Stat = ({ label, n, red }) => (
  <div className="rounded border border-slate-200 bg-white px-4 py-4 flex items-center justify-between" data-testid={`practice-activities-stat-${label.toLowerCase()}`}>
    <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span><span className={`text-xl font-semibold ${red && n > 0 ? "text-red-600" : "text-slate-800"}`}>{n}</span>
  </div>
);

export default function PracticeActivities() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") || "";
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("Any");
  const [assigned, setAssigned] = useState("");
  const [range, setRange] = useState({ preset: "All Time" });
  const [modal, setModal] = useState(null);
  const load = () => api.get("/practice/activities", { params: kind ? { kind } : {} }).then(r => setRows(r.data)).catch(() => setRows([]));
  useEffect(() => { load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const users = [...new Set((rows || []).flatMap(r => r.assigned_users || []))].sort();
  const shown = filterActivities(rows || [], { status, assigned, range });
  const completed = shown.filter(r => r.status === "Completed").length;
  const overdue = shown.filter(r => r.status === "Overdue").length;
  const incomplete = shown.filter(r => r.status && r.status !== "Completed").length;
  const done = () => { setModal(null); load(); };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-activities-page">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3"><ListChecks size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Activities</h1></div>
          <div className="flex items-center gap-2">
            <button type="button" className={white}><Upload size={14} /> Import</button>
            <button type="button" className={white}><Workflow size={14} /> Workflows</button>
            <NewActivityMenu align="right" testId="practice-activities-new" onPick={setModal} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <select className={`${sel} w-36 font-semibold rounded-full`} value={kind} onChange={e => setParams(e.target.value ? { kind: e.target.value } : {})} data-testid="practice-activities-kind">
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span>Status</span><select className={`${sel} w-32`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-activities-status"><option>Any</option><option>Completed</option><option>Overdue</option><option>Not Completed</option><option>In Progress</option><option>Scheduled</option></select>
          <span>Assigned To</span><UserFilter testId="practice-activities-assigned" value={assigned} onChange={setAssigned} options={users} /><span>Created By</span><UserFilter testId="practice-activities-created-by" /><TagsFilter testId="practice-activities-tags" /><span>Date Range</span><DateRangeFilter value={range} onChange={setRange} testId="practice-activities-range" />
        </div>
        <div className="grid grid-cols-4 gap-6"><Stat label="All" n={shown.length} /><Stat label="Completed" n={completed} /><Stat label="Incomplete" n={incomplete} /><Stat label="Overdue" n={overdue} red /></div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div> : <ActivitiesTable rows={shown} nav={nav} showContact onOpen={setModal} onLogTime={(r) => setModal({ logTime: r })} />}
        </div>
        <ActivityModal modal={modal} onClose={() => setModal(null)} onSaved={done} />
      </div>
    </PracticeShell>
  );
}
