import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Clock, Trash2, Users } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import TimeEntryForm from "@/components/TimeEntryForm";

/**
 * ProjectTimeTab — Time tab body for /accounting/projects/:id.
 *
 * Combines an inline TimeEntryForm (project pre-locked), a phase
 * roll-up card (hours × cost_rate → labor cost per phase), and the
 * full list of recent entries with delete. This is the read/write
 * face of Phase B-3's virtual labor cost.
 */
export default function ProjectTimeTab({ projectId }) {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [roll, setRoll] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!currentId || !projectId) return;
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        api.get(`/companies/${currentId}/time-entries/rollup?project_id=${projectId}`),
        api.get(`/companies/${currentId}/time-entries?project_id=${projectId}`),
      ]);
      setRoll(r1.data || null);
      setEntries(r2.data?.time_entries || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [currentId, projectId]);

  useEffect(() => { load(); }, [load]);

  const deleteEntry = async (t) => {
    if (!confirm(`Delete ${t.hours}h on ${t.date}?`)) return;
    try {
      await api.delete(`/companies/${currentId}/time-entries/${t.id}`);
      toast.success("Deleted");
      load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="space-y-5" data-testid="project-time-tab">
      {/* Log form — project is locked to this page's project. */}
      <TimeEntryForm
        defaultProjectId={projectId}
        lockedProjectId
        onSaved={load}
      />

      {/* Rollup summary */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="project-time-rollup-card">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <Clock size={14} className="text-emerald-600" /> Labor cost rollup
          {loading && <Loader2 size={12} className="inline animate-spin ml-1 text-slate-400" />}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Total hours"     value={(roll?.totals?.hours || 0).toFixed(2)} tone="slate"
                testId="rollup-total-hours" />
          <Kpi label="Labor cost"      value={fmt(roll?.totals?.cost || 0)} tone="emerald"
                testId="rollup-total-cost" />
          <Kpi label="Billable hours"  value={(roll?.totals?.billable_hours || 0).toFixed(2)} tone="cyan"
                testId="rollup-billable-hours" />
          <Kpi label="Billable value"  value={fmt(roll?.totals?.billable_cost || 0)} tone="indigo"
                testId="rollup-billable-cost" />
        </div>
        <div className="text-[11px] text-slate-500 italic">
          Roll-up is virtual — hours × cost rate at log time. No journal entry is posted; project P&amp;L reads this on demand.
        </div>
      </div>

      {/* By-phase rollup */}
      {roll && (roll.by_phase || []).length > 0 && (
        <div className="rounded-xl border bg-white" data-testid="project-time-by-phase">
          <div className="px-4 py-3 border-b text-sm font-semibold text-slate-900">Hours by phase</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50/60 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="text-left px-4 py-2">Phase</th>
                <th className="text-right px-4 py-2">Hours</th>
                <th className="text-right px-4 py-2">Billable</th>
                <th className="text-right px-4 py-2">Labor cost</th>
                <th className="text-right px-4 py-2">Entries</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roll.by_phase.map(p => (
                <tr key={p.phase_id || "_unassigned"}
                    data-testid={`phase-rollup-row-${p.phase_id || "_unassigned"}`}>
                  <td className="px-4 py-2 text-slate-800">
                    {p.phase_id ? p.phase_name : <span className="italic text-slate-500">Unassigned</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono-num">{p.hours.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-slate-500">{p.billable_hours.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-emerald-700">{fmt(p.cost)}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-slate-500">{p.entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* By-employee rollup */}
      {roll && (roll.by_employee || []).length > 0 && (
        <div className="rounded-xl border bg-white" data-testid="project-time-by-employee">
          <div className="px-4 py-3 border-b text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <Users size={13} className="text-slate-500" /> Hours by employee
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50/60 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="text-left px-4 py-2">Employee</th>
                <th className="text-right px-4 py-2">Hours</th>
                <th className="text-right px-4 py-2">Labor cost</th>
                <th className="text-right px-4 py-2">Entries</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roll.by_employee.map(e => (
                <tr key={e.employee_id}
                    data-testid={`emp-rollup-row-${e.employee_id}`}>
                  <td className="px-4 py-2 text-slate-800">{e.employee_name}</td>
                  <td className="px-4 py-2 text-right font-mono-num">{e.hours.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-emerald-700">{fmt(e.cost)}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-slate-500">{e.entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent entries */}
      <div className="rounded-xl border bg-white" data-testid="project-time-entries">
        <div className="px-4 py-3 border-b text-sm font-semibold text-slate-900 flex items-center justify-between">
          <span>Recent entries</span>
          <span className="text-[11px] text-slate-500 font-normal">{entries.length} shown</span>
        </div>
        {entries.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No time logged on this project yet.
            <div className="text-xs text-slate-400 italic mt-1">Use the form above to log your first hour.</div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map(t => (
              <li key={t.id}
                  data-testid={`project-time-entry-${t.id}`}
                  className="px-4 py-2 grid grid-cols-12 gap-2 items-center hover:bg-slate-50">
                <div className="col-span-2 text-xs text-slate-500 font-mono-num">{t.date}</div>
                <div className="col-span-3 text-sm text-slate-800 truncate">{t.employee_name}</div>
                <div className="col-span-3 text-xs text-slate-600 truncate">
                  {t.phase_name || <span className="italic text-slate-400">Unassigned</span>}
                  {t.notes && <span className="text-slate-400"> · {t.notes}</span>}
                </div>
                <div className="col-span-1 text-right">
                  {t.billable ? (
                    <span className="text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">bill</span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-100 border border-slate-200 rounded px-1">int</span>
                  )}
                </div>
                <div className="col-span-1 text-right font-mono-num text-sm text-slate-800">
                  {Number(t.hours).toFixed(2)}h
                </div>
                <div className="col-span-1 text-right font-mono-num text-xs text-emerald-700">
                  {fmt(Number(t.hours) * Number(t.cost_rate_snapshot || 0))}
                </div>
                <div className="col-span-1 flex justify-end">
                  <button onClick={() => deleteEntry(t)}
                          data-testid={`project-time-delete-${t.id}`}
                          className="p-1 rounded hover:bg-red-50 text-red-500" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = "slate", testId }) {
  const tones = {
    slate:   "text-slate-800 bg-slate-50/70 border-slate-200",
    emerald: "text-emerald-800 bg-emerald-50/70 border-emerald-200",
    cyan:    "text-cyan-800 bg-cyan-50/70 border-cyan-200",
    indigo:  "text-indigo-800 bg-indigo-50/70 border-indigo-200",
  };
  return (
    <div data-testid={testId} className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-mono-num mt-0.5">{value}</div>
    </div>
  );
}
