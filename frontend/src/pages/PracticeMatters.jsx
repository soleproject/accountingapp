import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Upload, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton } from "@/components/practice/forms";
import { sel, UserFilter, PillFilter, TagsFilter, CountCard, EmptyIllustration } from "@/components/practice/listParts";
import { MattersTable } from "@/components/practice/tables";
import { Can } from "@/components/practice/perms";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

export default function PracticeMatters() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get("status") || "Open");
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState(null);
  const [track, setTrack] = useState(null);

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
          <Can feature="Matters" action="create"><GreenButton onClick={() => nav("/practice/matters/new")} testId="practice-matters-new-btn"><Plus size={14} /> New</GreenButton></Can>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-matters-filters">
          <span>Assigned To</span><UserFilter testId="practice-matters-assigned-filter" />
          <span>Originated By</span><UserFilter testId="practice-matters-originated-filter" />
          <span>Status</span>
          <select className={`${sel} w-32`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-matters-status-filter">
            <option>Open</option><option>Closed</option><option>Pending</option><option>Billable</option><option>All</option>
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
            ) : <MattersTable rows={rows} nav={nav} onTrackTime={setTrack} />}
        </div>
      </div>
      {track && <NewTimeEntryModal task={{ contact_id: track.contact_id, matter_id: track.id }} onClose={() => setTrack(null)} onSaved={() => setTrack(null)} />}
    </PracticeShell>
  );
}
