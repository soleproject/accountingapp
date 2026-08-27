import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ChevronRight, Briefcase, Loader2, Plus, Trash2, Pencil, Check, X, Layers as LayersIcon, ArrowLeft } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Project detail page (Feb 2026) — replaces the modal drawer with
 * a proper URL-bound page so PMs can bookmark, share, and back-nav
 * to a single project's P&L + phases.
 *
 * Route: `/accounting/projects/:projectId`
 */
export default function ProjectDetail() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const { currentId, projectsEnabled } = useCompany();
  const fmtMoney = useMoneyFmt();

  const [project, setProject] = useState(null);
  const [prof, setProf] = useState(null);
  const [phases, setPhases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newPhaseName, setNewPhaseName] = useState("");
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [editing, setEditing] = useState(null); // {id, name}

  // Small phase-status vocabulary. Reused for the per-row dropdown.
  const PHASE_STATUS = [
    ["planning",     "Planning"],
    ["in_progress",  "In progress"],
    ["on_hold",      "On hold"],
    ["completed",    "Completed"],
    ["cancelled",    "Cancelled"],
  ];

  const load = async () => {
    if (!currentId || !projectId) return;
    setLoading(true);
    try {
      const [prj, r, ph] = await Promise.all([
        api.get(`/companies/${currentId}/projects?include_inactive=1`),
        api.get(`/companies/${currentId}/reports/project-profitability?project_id=${projectId}&group_by_phase=1`),
        api.get(`/companies/${currentId}/projects/${projectId}/phases`),
      ]);
      const found = (prj.data?.projects || []).find(p => p.id === projectId);
      setProject(found || r.data?.project || null);
      setProf(r.data);
      setPhases(ph.data?.phases || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, projectId]);

  const addPhase = async () => {
    const name = newPhaseName.trim();
    if (!name) return;
    setPhaseBusy(true);
    try {
      await api.post(
        `/companies/${currentId}/projects/${projectId}/phases`,
        { name });
      setNewPhaseName("");
      await load();
      toast.success(`Phase "${name}" added`);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setPhaseBusy(false);
    }
  };
  const deletePhase = async (phaseId) => {
    if (!confirm("Delete this phase? Only allowed if nothing references it.")) return;
    try {
      await api.delete(
        `/companies/${currentId}/projects/${projectId}/phases/${phaseId}`);
      toast.success("Phase deleted");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const setPhaseStatus = async (phase, status) => {
    try {
      await api.patch(
        `/companies/${currentId}/projects/${projectId}/phases/${phase.id}`,
        { status });
      toast.success(`Marked ${status.replace("_", " ")}`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const saveRename = async (phase) => {
    const name = (editing?.name || "").trim();
    if (!name || name === phase.name) { setEditing(null); return; }
    try {
      await api.patch(
        `/companies/${currentId}/projects/${projectId}/phases/${phase.id}`,
        { name });
      toast.success("Renamed");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  // Phase P&L (`by_phase`) doesn't include per-phase metadata like
  // status — merge in the phase-detail rows fetched separately so
  // the row can render its status dropdown alongside the money.
  const phaseMetaById = Object.fromEntries((phases || []).map(p => [p.id, p]));

  if (!projectsEnabled) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-3" data-testid="project-detail-disabled">
        <Briefcase size={26} className="mx-auto text-slate-400" />
        <h2 className="text-lg font-semibold text-slate-900">Projects aren't enabled</h2>
        <Link to="/settings" className="text-cyan-600 hover:underline text-sm">Enable in Settings →</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-5" data-testid="project-detail-page">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-slate-500" data-testid="project-detail-breadcrumb">
        <Link to="/accounting/projects" className="hover:text-slate-800 inline-flex items-center gap-1">
          <ArrowLeft size={12} /> Projects
        </Link>
        <ChevronRight size={12} />
        <span className="text-slate-900 font-medium truncate">
          {project?.name || (loading ? "Loading…" : "Project")}
        </span>
      </div>

      {loading || !prof ? (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Project profitability</div>
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">{project?.name}</h1>
              <div className="text-sm text-slate-500 mt-0.5">
                {project?.contact_name || "—"} · <span className="capitalize">{project?.status?.replace("_", " ") || ""}</span>
              </div>
            </div>
          </div>

          {/* P&L rollup */}
          <div className="rounded-xl border bg-white p-5 space-y-3 text-sm" data-testid="project-pl-card">
            <MoneyRow label="Revenue" value={prof.revenue.total} className="text-emerald-700 font-semibold" fmt={fmtMoney} />
            <MoneyRow label="Cost of goods sold" value={-prof.cogs.total} fmt={fmtMoney} />
            <MoneyRow label="Gross profit" value={prof.gross_profit}
                        className="text-slate-900 font-semibold border-t pt-2" fmt={fmtMoney} />
            <MoneyRow label="Operating expenses" value={-prof.expenses.total} fmt={fmtMoney} />
            <MoneyRow label="Net income" value={prof.net_income}
                        className={`font-bold border-t pt-2 ${prof.net_income >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                        fmt={fmtMoney} />
            {prof.estimated_revenue ? (
              <div className="mt-2 rounded-lg bg-slate-50 p-3">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Estimate</div>
                <div className="flex justify-between items-baseline mt-1">
                  <span className="text-sm text-slate-700">{fmtMoney(prof.estimated_revenue)} est.</span>
                  <span className={`text-sm font-semibold ${prof.pct_of_estimate >= 100 ? "text-emerald-700" : "text-slate-800"}`}>
                    {prof.pct_of_estimate ?? 0}% earned
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.min(100, prof.pct_of_estimate ?? 0)}%` }} />
                </div>
              </div>
            ) : null}
          </div>

          {/* Phases */}
          <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="project-phases-card">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                <LayersIcon size={14} className="text-cyan-600" /> Phases
              </div>
              <span className="text-xs text-slate-400">{phases.length}</span>
            </div>
            <div className="flex gap-2">
              <input value={newPhaseName}
                      onChange={(e) => setNewPhaseName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addPhase(); }}
                      placeholder="Add a phase (e.g. Framing)…"
                      data-testid="project-phase-new-input"
                      className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
              <button onClick={addPhase}
                        disabled={!newPhaseName.trim() || phaseBusy}
                        data-testid="project-phase-add-btn"
                        className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700 disabled:opacity-50">
                {phaseBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
              </button>
            </div>
            {(prof.by_phase || []).length === 0 ? (
              <div className="text-xs text-slate-400 italic py-2">
                No phases yet — add one above and tag transactions to see per-phase P&amp;L.
              </div>
            ) : (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="text-left px-3 py-2">Phase</th>
                      <th className="text-right px-3 py-2">Revenue</th>
                      <th className="text-right px-3 py-2">Cost</th>
                      <th className="text-right px-3 py-2">Net</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(prof.by_phase || []).map(ph => {
                      const meta = ph.id ? phaseMetaById[ph.id] : null;
                      const isEditing = editing?.id === ph.id;
                      return (
                      <tr key={ph.id || "_unphased_"}
                          data-testid={`project-phase-row-${ph.id || "_unphased_"}`}
                          className={meta?.status === "completed" ? "opacity-60" : ""}>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <div className="flex gap-1 items-center">
                              <input autoFocus value={editing.name}
                                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveRename(ph);
                                        if (e.key === "Escape") setEditing(null);
                                      }}
                                      data-testid={`project-phase-rename-input-${ph.id}`}
                                      className="flex-1 border border-slate-300 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
                              <button onClick={() => saveRename(ph)}
                                        className="p-1 rounded hover:bg-slate-100 text-emerald-700"
                                        data-testid={`project-phase-rename-save-${ph.id}`}>
                                <Check size={12} />
                              </button>
                              <button onClick={() => setEditing(null)}
                                        className="p-1 rounded hover:bg-slate-100 text-slate-500">
                                <X size={12} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className={ph.id ? "text-slate-800" : "italic text-slate-500"}>{ph.name}</span>
                              {meta?.status === "completed" && (
                                <span className="text-[9px] uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">done</span>
                              )}
                              {ph.id && (
                                <button onClick={() => setEditing({ id: ph.id, name: ph.name })}
                                          className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
                                          title="Rename"
                                          data-testid={`project-phase-rename-btn-${ph.id}`}>
                                  <Pencil size={11} />
                                </button>
                              )}
                            </div>
                          )}
                          {ph.id && meta && !isEditing && (
                            <select value={meta.status || "in_progress"}
                                      onChange={(e) => setPhaseStatus(meta, e.target.value)}
                                      data-testid={`project-phase-status-${ph.id}`}
                                      className="mt-1 text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-600">
                              {PHASE_STATUS.map(([k, v]) => (
                                <option key={k} value={k}>{v}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono-num text-emerald-700">{fmtMoney(ph.revenue)}</td>
                        <td className="px-3 py-2 text-right font-mono-num text-slate-700">{fmtMoney(ph.cogs + ph.expenses)}</td>
                        <td className={`px-3 py-2 text-right font-mono-num font-semibold ${ph.net_income >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                          {fmtMoney(ph.net_income)}
                        </td>
                        <td className="text-right pr-2">
                          {ph.id && (
                            <button onClick={() => deletePhase(ph.id)}
                                      className="p-1 rounded hover:bg-red-50 text-red-500"
                                      data-testid={`project-phase-delete-${ph.id}`}
                                      title="Delete (only if unused)">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MoneyRow({ label, value, className = "", fmt }) {
  return (
    <div className={`flex justify-between items-baseline ${className}`}>
      <span>{label}</span>
      <span className="font-mono-num">{fmt(value)}</span>
    </div>
  );
}
