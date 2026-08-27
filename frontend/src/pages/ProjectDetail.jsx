import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ChevronRight, Briefcase, Loader2, Plus, Trash2, Pencil, Check, X,
  Layers as LayersIcon, ArrowLeft, Calendar, FileText, Receipt,
  Coins, GanttChart, ExternalLink,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import InvoiceEditor from "@/pages/InvoiceEditor";
import BillEditor from "@/pages/BillEditor";
import EstimateEditor from "@/pages/EstimateEditor";
import PhaseFormModal from "@/components/PhaseFormModal";
import NotesBlock from "@/components/NotesBlock";

/**
 * Project detail page (Feb 2026) — 3-tab layout.
 *
 * Tabs:
 *   1. Overview  — P&L rollup + Phases table + inline status/rename.
 *   2. Timeline  — Project + Phase date pickers, Gantt chart.
 *   3. Documents — Every project-linked Estimate/Invoice/Bill/Receipt
 *                  + quick-create buttons (deep-links pre-fill the
 *                  editor with ?project_id=<id>).
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
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("overview"); // "overview" | "timeline" | "documents"
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [editing, setEditing] = useState(null); // {id, name}
  const [phaseModal, setPhaseModal] = useState(null); // null | {mode:"create"|"edit", phase?}
  // Docs-drawer state — { kind: "invoice"|"bill"|"estimate", docId: string|null, phaseId: string|null }
  const [docDrawer, setDocDrawer] = useState(null);

  const PHASE_STATUS = [
    ["planning",     "Planning"],
    ["in_progress",  "In progress"],
    ["on_hold",      "On hold"],
    ["completed",    "Completed"],
    ["cancelled",    "Cancelled"],
  ];
  const PHASE_STATUS_COLORS = {
    planning:     "bg-slate-300",
    in_progress:  "bg-cyan-500",
    on_hold:      "bg-amber-400",
    completed:    "bg-emerald-500",
    cancelled:    "bg-rose-400",
  };

  const load = async () => {
    if (!currentId || !projectId) return;
    setLoading(true);
    try {
      const [prj, r, ph, docs] = await Promise.all([
        api.get(`/companies/${currentId}/projects?include_inactive=1`),
        api.get(`/companies/${currentId}/reports/project-profitability?project_id=${projectId}&group_by_phase=1`),
        api.get(`/companies/${currentId}/projects/${projectId}/phases`),
        api.get(`/companies/${currentId}/projects/${projectId}/documents`),
      ]);
      const found = (prj.data?.projects || []).find(p => p.id === projectId);
      setProject(found || r.data?.project || null);
      setProf(r.data);
      setPhases(ph.data?.phases || []);
      setDocuments(docs.data?.documents || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, projectId]);

  const createPhase = async (payload) => {
    try {
      const r = await api.post(
        `/companies/${currentId}/projects/${projectId}/phases`,
        payload);
      toast.success(`Phase "${payload.name}" added`);
      await load();
      return r.data.phase;
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
      throw e;
    }
  };
  const updatePhaseFull = async (phaseId, payload) => {
    try {
      const r = await api.patch(
        `/companies/${currentId}/projects/${projectId}/phases/${phaseId}`,
        payload);
      toast.success("Phase saved");
      await load();
      return r.data.phase;
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
      throw e;
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
  const patchPhase = async (phase, patch) => {
    try {
      await api.patch(
        `/companies/${currentId}/projects/${projectId}/phases/${phase.id}`,
        patch);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const setPhaseStatus = (phase, status) => patchPhase(phase, { status });
  const setPhaseDate = (phase, field, val) =>
    patchPhase(phase, { [field]: val || null });
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
  const patchProject = async (patch) => {
    try {
      await api.patch(
        `/companies/${currentId}/projects/${projectId}`, patch);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

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
    <div className="max-w-6xl space-y-5" data-testid="project-detail-page">
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
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Project</div>
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">{project?.name}</h1>
              <div className="text-sm text-slate-500 mt-0.5">
                {project?.contact_name || "—"} · <span className="capitalize">{project?.status?.replace("_", " ") || ""}</span>
                {(project?.start_date || project?.end_date) && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-slate-500">
                    <Calendar size={11} />
                    {project?.start_date || "—"} → {project?.end_date || "—"}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b" data-testid="project-detail-tabs">
            <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}
                    testId="project-tab-overview" icon={<Coins size={13} />} label="Overview" />
            <TabBtn active={tab === "timeline"} onClick={() => setTab("timeline")}
                    testId="project-tab-timeline" icon={<GanttChart size={13} />} label="Timeline" />
            <TabBtn active={tab === "documents"} onClick={() => setTab("documents")}
                    testId="project-tab-documents" icon={<FileText size={13} />}
                    label="Documents" badge={documents.length} />
          </div>

          {tab === "overview" && (
            <>
              <OverviewTab
                prof={prof} fmtMoney={fmtMoney}
                phases={phases} phaseMetaById={phaseMetaById}
                PHASE_STATUS={PHASE_STATUS}
                onAddPhase={() => setPhaseModal({ mode: "create" })}
                onEditPhase={(phase) => setPhaseModal({ mode: "edit", phase })}
                deletePhase={deletePhase} setPhaseStatus={setPhaseStatus}
                editing={editing} setEditing={setEditing} saveRename={saveRename}
              />
              <NotesBlock entityType="project" entityId={projectId} title="Project notes" />
            </>
          )}
          {tab === "timeline" && (
            <TimelineTab
              project={project} phases={phases} prof={prof}
              PHASE_STATUS={PHASE_STATUS}
              PHASE_STATUS_COLORS={PHASE_STATUS_COLORS}
              patchProject={patchProject}
              setPhaseDate={setPhaseDate}
              setPhaseStatus={setPhaseStatus}
            />
          )}
          {tab === "documents" && (
            <DocumentsTab
              documents={documents} projectId={projectId}
              phaseMetaById={phaseMetaById}
              fmtMoney={fmtMoney}
              onOpenDrawer={(kind, docId = null) => setDocDrawer({ kind, docId })}
            />
          )}
        </>
      )}

      {/* Document drawer — slides in from the right and renders the
          full-featured editor for Invoice / Bill / Estimate inline. */}
      {docDrawer && (
        <DocDrawer
          kind={docDrawer.kind}
          docId={docDrawer.docId}
          projectId={projectId}
          phaseId={docDrawer.phaseId}
          onClose={() => setDocDrawer(null)}
          onSaved={(newId) => {
            setDocDrawer(prev => prev ? { ...prev, docId: newId } : null);
            load();
          }}
        />
      )}

      {/* Phase create / edit modal */}
      {phaseModal && (
        <PhaseFormModal
          open
          onClose={() => setPhaseModal(null)}
          onSubmit={async (payload) => {
            if (phaseModal.mode === "edit" && phaseModal.phase) {
              return await updatePhaseFull(phaseModal.phase.id, payload);
            }
            return await createPhase(payload);
          }}
          projectId={projectId}
          contactId={project?.contact_id}
          initial={phaseModal.mode === "edit" ? phaseModal.phase : null}
          onOpenDocDrawer={(kind, phase) => setDocDrawer({
            kind, docId: null, phaseId: phase?.id || null,
          })}
          onLinkedDocsChanged={load}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------
function TabBtn({ active, onClick, testId, icon, label, badge }) {
  return (
    <button onClick={onClick}
            data-testid={testId}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
              active
                ? "border-cyan-600 text-cyan-700 font-medium"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}>
      {icon} {label}
      {badge ? (
        <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono-num bg-slate-100 text-slate-600">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------
// OVERVIEW TAB
// ---------------------------------------------------------------
function OverviewTab({
  prof, fmtMoney, phases, phaseMetaById, PHASE_STATUS,
  onAddPhase, onEditPhase,
  deletePhase, setPhaseStatus, editing, setEditing, saveRename,
}) {
  return (
    <>
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
            <span className="text-xs text-slate-400 font-normal">({phases.length})</span>
          </div>
          <button onClick={onAddPhase}
                    data-testid="project-phase-add-btn"
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-cyan-600 text-white text-xs hover:bg-cyan-700">
            <Plus size={12} /> Add phase
          </button>
        </div>
        {(prof.by_phase || []).length === 0 ? (
          <div className="text-xs text-slate-400 italic py-4 text-center">
            No phases yet — click <b>Add phase</b> to get started. Once phases exist, tag transactions and docs to them for per-phase P&amp;L.
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
                          {ph.id && meta && (
                            <button onClick={() => onEditPhase(meta)}
                                      className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
                                      title="Edit phase"
                                      data-testid={`project-phase-edit-btn-${ph.id}`}>
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
  );
}

// ---------------------------------------------------------------
// TIMELINE TAB — date pickers + Gantt chart
// ---------------------------------------------------------------
function TimelineTab({
  project, phases, prof, PHASE_STATUS, PHASE_STATUS_COLORS,
  patchProject, setPhaseDate, setPhaseStatus,
}) {
  // Compute the range for the Gantt. Union of project dates + all
  // phase dates. Fallback to today ±30d if nothing set yet.
  const range = useMemo(() => {
    const dates = [];
    for (const d of [project?.start_date, project?.end_date]) {
      if (d) dates.push(new Date(d));
    }
    for (const p of phases || []) {
      if (p.start_date) dates.push(new Date(p.start_date));
      if (p.end_date) dates.push(new Date(p.end_date));
    }
    if (dates.length === 0) {
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 86400000);
      const end   = new Date(now.getTime() + 60 * 86400000);
      return { min: start, max: end };
    }
    const min = new Date(Math.min(...dates.map(d => d.getTime())));
    const max = new Date(Math.max(...dates.map(d => d.getTime())));
    // Pad 3 days each side so bars aren't flush against the axis.
    return {
      min: new Date(min.getTime() - 3 * 86400000),
      max: new Date(max.getTime() + 3 * 86400000),
    };
  }, [project, phases]);
  const spanMs = range.max.getTime() - range.min.getTime() || 1;
  const pct = (iso) => {
    if (!iso) return null;
    return ((new Date(iso).getTime() - range.min.getTime()) / spanMs) * 100;
  };
  const width = (start, end) => {
    if (!start || !end) return null;
    return ((new Date(end).getTime() - new Date(start).getTime()) / spanMs) * 100;
  };

  return (
    <div className="space-y-5">
      {/* Project timeframe editor */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="timeline-project-card">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <Calendar size={14} className="text-cyan-600" /> Project timeframe
        </div>
        <div className="flex gap-4 items-end flex-wrap">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 block">Start</label>
            <input type="date" defaultValue={project?.start_date || ""}
                    onBlur={(e) => e.target.value !== (project?.start_date || "") &&
                                    patchProject({ start_date: e.target.value || null })}
                    data-testid="timeline-project-start"
                    className="border rounded px-2 py-1.5 text-sm bg-white" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 block">End</label>
            <input type="date" defaultValue={project?.end_date || ""}
                    onBlur={(e) => e.target.value !== (project?.end_date || "") &&
                                    patchProject({ end_date: e.target.value || null })}
                    data-testid="timeline-project-end"
                    className="border rounded px-2 py-1.5 text-sm bg-white" />
          </div>
          <div className="text-xs text-slate-500">
            Bars on the Gantt chart below draw from these dates and update on blur.
          </div>
        </div>
      </div>

      {/* Phase timeframe editors */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="timeline-phases-card">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <LayersIcon size={14} className="text-cyan-600" /> Phase timeframes
        </div>
        {phases.length === 0 ? (
          <div className="text-xs text-slate-400 italic py-2">
            No phases yet — add them on the Overview tab.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className="text-left py-1">Phase</th>
                <th className="text-left py-1">Start</th>
                <th className="text-left py-1">End</th>
                <th className="text-left py-1">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {phases.map(ph => (
                <tr key={ph.id} data-testid={`timeline-phase-row-${ph.id}`}>
                  <td className="py-1.5 text-slate-800">{ph.name}</td>
                  <td className="py-1.5">
                    <input type="date" defaultValue={ph.start_date || ""}
                            onBlur={(e) => e.target.value !== (ph.start_date || "") &&
                                            setPhaseDate(ph, "start_date", e.target.value)}
                            data-testid={`timeline-phase-start-${ph.id}`}
                            className="border rounded px-2 py-1 text-xs bg-white" />
                  </td>
                  <td className="py-1.5">
                    <input type="date" defaultValue={ph.end_date || ""}
                            onBlur={(e) => e.target.value !== (ph.end_date || "") &&
                                            setPhaseDate(ph, "end_date", e.target.value)}
                            data-testid={`timeline-phase-end-${ph.id}`}
                            className="border rounded px-2 py-1 text-xs bg-white" />
                  </td>
                  <td className="py-1.5">
                    <select value={ph.status || "in_progress"}
                              onChange={(e) => setPhaseStatus(ph, e.target.value)}
                              className="text-xs border rounded px-1 py-0.5 bg-white">
                      {PHASE_STATUS.map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Gantt chart */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="timeline-gantt-card">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <GanttChart size={14} className="text-cyan-600" /> Gantt view
        </div>
        <div className="text-[10px] text-slate-500 flex items-center gap-3">
          <span>{fmtDate(range.min)}</span>
          <span className="flex-1 border-b border-dashed border-slate-200" />
          <span>{fmtDate(range.max)}</span>
        </div>
        {/* Project span (background bar) */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-40 text-xs font-medium text-slate-800 truncate">
              {project?.name}
            </div>
            <div className="flex-1 relative h-6 bg-slate-100 rounded overflow-hidden">
              {project?.start_date && project?.end_date && (
                <div className="absolute top-0 h-full bg-cyan-100 border border-cyan-300 rounded"
                      style={{
                        left: `${Math.max(0, pct(project.start_date))}%`,
                        width: `${Math.max(1, width(project.start_date, project.end_date))}%`,
                      }}
                      title={`${project.start_date} → ${project.end_date}`}
                      data-testid="gantt-project-bar" />
              )}
              {!(project?.start_date && project?.end_date) && (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-400 italic">
                  Set project start + end dates above
                </div>
              )}
            </div>
          </div>
          {phases.map(ph => (
            <div key={ph.id} className="flex items-center gap-3" data-testid={`gantt-phase-${ph.id}`}>
              <div className="w-40 text-xs text-slate-700 truncate flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${PHASE_STATUS_COLORS[ph.status] || "bg-slate-300"}`} />
                {ph.name}
              </div>
              <div className="flex-1 relative h-5 bg-slate-50 rounded overflow-hidden">
                {ph.start_date && ph.end_date ? (
                  <div className={`absolute top-0 h-full ${PHASE_STATUS_COLORS[ph.status] || "bg-slate-300"} opacity-80 rounded`}
                        style={{
                          left: `${Math.max(0, pct(ph.start_date))}%`,
                          width: `${Math.max(1, width(ph.start_date, ph.end_date))}%`,
                        }}
                        title={`${ph.start_date} → ${ph.end_date}`} />
                ) : (
                  <div className="absolute inset-0 flex items-center pl-2 text-[10px] text-slate-400 italic">
                    (no dates)
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {/* Legend */}
        <div className="flex flex-wrap gap-2 pt-2 text-[10px]">
          {PHASE_STATUS.map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1 text-slate-600">
              <span className={`inline-block w-2 h-2 rounded-full ${PHASE_STATUS_COLORS[k]}`} />
              {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// DOCUMENTS TAB — linked invoices / bills / estimates / receipts
// ---------------------------------------------------------------
function DocumentsTab({ documents, projectId, phaseMetaById, fmtMoney, onOpenDrawer }) {
  const KIND_META = {
    estimate: { label: "Estimate",       color: "amber",   Icon: FileText },
    invoice:  { label: "Invoice",        color: "indigo",  Icon: FileText },
    bill:     { label: "Bill",           color: "rose",    Icon: Receipt  },
    receipt:  { label: "Sales receipt",  color: "emerald", Icon: Receipt  },
  };
  // Drawer-supported kinds — receipts still open the full route since
  // the receipt editor is much simpler and not yet drawer-embed-ready.
  const DRAWER_KINDS = new Set(["invoice", "bill", "estimate"]);
  const nav = useNavigate();
  const openDoc = (doc) => {
    if (DRAWER_KINDS.has(doc.kind)) {
      onOpenDrawer(doc.kind, doc.id);
      return;
    }
    // Fallback: receipts / any future kinds → full route.
    const routeMap = { receipt: "receipts" };
    const route = routeMap[doc.kind];
    if (route) nav(`/${route}/${doc.id}/edit`);
  };
  const createDoc = (kind) => onOpenDrawer(kind, null);
  return (
    <div className="rounded-xl border bg-white p-5 space-y-4" data-testid="project-documents-card">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <FileText size={14} className="text-cyan-600" /> Linked documents
          <span className="text-xs text-slate-400 font-normal">({documents.length})</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => createDoc("estimate")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-amber-200 bg-amber-50 text-amber-700 text-xs hover:bg-amber-100"
                    data-testid="project-new-estimate">
            <Plus size={12} /> New estimate
          </button>
          <button onClick={() => createDoc("invoice")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs hover:bg-indigo-100"
                    data-testid="project-new-invoice">
            <Plus size={12} /> New invoice
          </button>
          <button onClick={() => createDoc("bill")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 text-xs hover:bg-rose-100"
                    data-testid="project-new-bill">
            <Plus size={12} /> New bill
          </button>
        </div>
      </div>
      {documents.length === 0 ? (
        <div className="text-center py-8 text-sm text-slate-500">
          No estimates, invoices, or bills linked to this project yet.
          <div className="text-xs text-slate-400 mt-1 italic">
            Use the buttons above to create one — it'll auto-link.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Number</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Contact</th>
                <th className="text-left px-3 py-2">Phase</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-right px-3 py-2">Balance</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documents.map(d => {
                const meta = KIND_META[d.kind] || {};
                const phaseName = d.phase_id ? phaseMetaById[d.phase_id]?.name : null;
                return (
                  <tr key={`${d.kind}-${d.id}`}
                      onClick={() => openDoc(d)}
                      className="hover:bg-slate-50 cursor-pointer"
                      data-testid={`project-doc-${d.kind}-${d.id}`}>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-${meta.color}-50 text-${meta.color}-700 border border-${meta.color}-200`}>
                        {meta.label || d.kind}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono-num text-slate-800">{d.number || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{d.date || "—"}</td>
                    <td className="px-3 py-2 text-slate-700 truncate max-w-[180px]">{d.contact_name || "—"}</td>
                    <td className="px-3 py-2 text-slate-600 text-xs">{phaseName || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono-num text-slate-800">{fmtMoney(d.total)}</td>
                    <td className={`px-3 py-2 text-right font-mono-num ${d.balance_due > 0 ? "text-amber-700" : "text-slate-500"}`}>
                      {fmtMoney(d.balance_due)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 capitalize">{d.status || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Slide-over drawer that hosts the full Invoice / Bill / Estimate
// editor. Opens from the right on desktop, blocks the underlying
// page with a scrim. Editors receive `embed` props so they skip
// URL-based init and call our onSaved callback instead of navigating.
// ---------------------------------------------------------------
function DocDrawer({ kind, docId, projectId, phaseId, onClose, onSaved }) {
  const nav = useNavigate();
  // ESC closes the drawer to feel like a native dialog.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const KIND_LABELS = { invoice: "Invoice", bill: "Bill", estimate: "Estimate" };
  const KIND_ROUTES = { invoice: "invoices", bill: "bills", estimate: "estimates" };
  const editorProps = {
    embed: {
      projectId,
      phaseId,
      onSaved,
      onClose,
      // Editor-specific id key so the same drawer shape drives all 3.
      ...(kind === "invoice"  ? { invoiceId:  docId } : {}),
      ...(kind === "bill"     ? { billId:     docId } : {}),
      ...(kind === "estimate" ? { estimateId: docId } : {}),
    },
  };
  const Editor = kind === "invoice" ? InvoiceEditor
              : kind === "bill" ? BillEditor
              : kind === "estimate" ? EstimateEditor
              : null;

  return (
    <div className="fixed inset-0 z-[80] flex justify-end"
          role="dialog" aria-modal="true"
          data-testid="project-doc-drawer">
      {/* Scrim */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
            onClick={onClose} />
      {/* Panel */}
      <div className="relative bg-slate-50 shadow-2xl h-full w-full max-w-4xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Sticky top-bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b bg-white shadow-sm">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span className="font-semibold uppercase tracking-wider text-slate-500">
              {docId ? `Edit ${KIND_LABELS[kind]}` : `New ${KIND_LABELS[kind]}`}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500 italic">This project</span>
          </div>
          <div className="flex items-center gap-2">
            {docId && (
              <button onClick={() => {
                        onClose();
                        nav(`/${KIND_ROUTES[kind]}/${docId}/edit`);
                      }}
                      title="Open in full page"
                      data-testid="project-doc-drawer-fullscreen"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-slate-600 text-xs hover:bg-slate-50">
                <ExternalLink size={11} /> Full page
              </button>
            )}
            <button onClick={onClose}
                    title="Close (Esc)"
                    data-testid="project-doc-drawer-close"
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
              <X size={16} />
            </button>
          </div>
        </div>
        {/* Editor body */}
        <div className="flex-1 overflow-y-auto p-4">
          {Editor && <Editor {...editorProps} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
function MoneyRow({ label, value, className = "", fmt }) {
  return (
    <div className={`flex justify-between items-baseline ${className}`}>
      <span>{label}</span>
      <span className="font-mono-num">{fmt(value)}</span>
    </div>
  );
}

function fmtDate(d) {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}
