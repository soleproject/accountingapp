import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Upload, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton } from "@/components/practice/forms";
import { sel, money, Avatar, UserFilter, PillFilter, TagsFilter, CountCard, ListToolbar, ListHead, ListFooter, EmptyIllustration } from "@/components/practice/listParts";

const COLS = ["Matter", "Contact", "Matter Rate", "Trust", "Operating", "Billable", "Assigned To", "Contact Tags", "Tags"];

function MattersTable({ rows, nav }) {
  const [q, setQ] = useState("");
  const shown = rows.filter(r => (r.name + " " + r.contact_name).toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-testid="practice-matters-table">
      <ListToolbar q={q} setQ={setQ} placeholder="Search Matters..." testId="practice-matters-search" />
      <table className="w-full text-sm">
        <ListHead cols={COLS} />
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className="border-t border-slate-200 hover:bg-slate-50" data-testid={`practice-matter-row-${r.id}`}>
              <td className="px-4 py-4"><input type="checkbox" className="h-4 w-4" /></td>
              <td className="px-2 py-4"><span className="font-semibold text-[#1E88E5] text-[15px]" data-testid={`practice-matter-link-${r.id}`}>{r.name}</span></td>
              <td className="px-2 py-4"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className="text-[#1E88E5] hover:underline">{r.contact_name}</button></td>
              <td className="px-2 py-4 text-slate-700">{r.matter_rate}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4"><Avatar name={r.assigned_to} /></td>
              <td className="px-2 py-4 text-slate-500">{(r.contact_tags || []).join(", ")}</td>
              <td className="px-2 py-4 text-slate-500">{(r.tags || []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListFooter count={shown.length} />
    </div>
  );
}

export default function PracticeMatters() {
  const nav = useNavigate();
  const [status, setStatus] = useState("Open");
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    setRows(null);
    Promise.all([api.get("/practice/matters", { params: { status } }), api.get("/practice/matters/counts")])
      .then(([r, c]) => { setRows(r.data); setCounts(c.data); })
      .catch(() => { setRows([]); toast.error("Could not load matters"); });
  }, [status]);

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-matters">
        <div className="flex items-center gap-6">
          <h1 className="text-2xl font-bold text-slate-800">Matters</h1>
          <button type="button" className="text-sm font-semibold text-[#1E88E5]" data-testid="practice-matters-grid-toggle">Switch to Modern Grid</button>
          <div className="flex-1" />
          <button type="button" data-testid="practice-matters-import-btn"
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Upload size={14} /> Import</button>
          <GreenButton onClick={() => nav("/practice/matters/new")} testId="practice-matters-new-btn"><Plus size={14} /> New</GreenButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-matters-filters">
          <span>Assigned To</span><UserFilter testId="practice-matters-assigned-filter" />
          <span>Originated By</span><UserFilter testId="practice-matters-originated-filter" />
          <span>Status</span>
          <select className={`${sel} w-32`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-matters-status-filter">
            <option>Open</option><option>Closed</option><option>Pending</option><option>All</option>
          </select>
          <TagsFilter testId="practice-matters-tags-filter" />
          <PillFilter testId="practice-matters-created-filter">Create…</PillFilter>
          <PillFilter testId="practice-matters-date-filter">All Time</PillFilter>
        </div>
        {counts && counts.all > 0 && (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
            <CountCard label="All" value={counts.all} testId="practice-matters-count-all" />
            <CountCard label="Open" value={counts.open} testId="practice-matters-count-open" />
            <CountCard label="Created This Month" value={counts.created_this_month} testId="practice-matters-count-month" />
            <CountCard label="Created Last Month" value={counts.created_last_month} testId="practice-matters-count-last-month" />
          </div>
        )}
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div>
            : rows.length === 0 ? (
              <EmptyIllustration icon={Briefcase} testId="practice-matters-empty">
                <p className="text-sm text-slate-700">Keep track of your Matters.</p>
                <p className="text-sm text-slate-700">Click the green "New" button at the top or read our <span className="text-[#1E88E5]">matters tutorial</span>.</p>
              </EmptyIllustration>
            ) : <MattersTable rows={rows} nav={nav} />}
        </div>
      </div>
    </PracticeShell>
  );
}
