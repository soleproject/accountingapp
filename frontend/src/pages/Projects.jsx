import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Plus, Loader2, Check, X, Trash2, Layers as LayersIcon } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Projects list page (Phase 3 advanced features, Feb 2026).
 *
 * Renders when the current company has `features.projects_enabled=true`.
 * Deep-linking with the flag off shows an inline "Enable Projects"
 * fallback with a one-click toggle.
 *
 * Design mirrors `/accounting/classes`: a quick-add form (name +
 * customer) then a compact list with status, estimated revenue, and
 * an inline profitability drill via the row link.
 */
const STATUS_LABELS = {
  planning: "Planning",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export default function Projects() {
  const { currentId, current, projectsEnabled, refresh } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [form, setForm] = useState({
    name: "", contact_id: "", estimated_revenue: "",
  });
  const [creating, setCreating] = useState(false);
  const [activeProject, setActiveProject] = useState(null);
  const [profitability, setProfitability] = useState(null);
  const [phases, setPhases] = useState([]);
  const [newPhaseName, setNewPhaseName] = useState("");
  const [phaseBusy, setPhaseBusy] = useState(false);
  const nav = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [p, c] = await Promise.all([
        api.get(`/companies/${currentId}/projects` +
                (showCancelled ? "?include_inactive=1" : "")),
        api.get(`/companies/${currentId}/contacts?type=customer&limit=500`),
      ]);
      setRows(p.data?.projects || []);
      setContacts(c.data?.contacts || c.data || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, showCancelled]);

  const contactById = useMemo(
    () => Object.fromEntries((contacts || []).map(c => [c.id, c])),
    [contacts],
  );

  const create = async () => {
    if (!form.name.trim() || !form.contact_id) return;
    setCreating(true);
    try {
      await api.post(`/companies/${currentId}/projects`, {
        name: form.name.trim(),
        contact_id: form.contact_id,
        estimated_revenue: form.estimated_revenue
          ? Number(form.estimated_revenue) : null,
      });
      setForm({ name: "", contact_id: "", estimated_revenue: "" });
      toast.success("Project created");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (row, status) => {
    try {
      await api.patch(`/companies/${currentId}/projects/${row.id}`,
                      { status });
      toast.success(`Marked ${STATUS_LABELS[status] || status}`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const hardDelete = async (row) => {
    if (!confirm(`Delete "${row.name}"? This can't be undone.`)) return;
    try {
      await api.delete(
        `/companies/${currentId}/projects/${row.id}?hard=1`);
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const openProfitability = async (row) => {
    setActiveProject(row);
    setProfitability(null);
    setPhases([]);
    try {
      const [r, pr] = await Promise.all([
        api.get(
          `/companies/${currentId}/reports/project-profitability?project_id=${row.id}&group_by_phase=1`),
        api.get(
          `/companies/${currentId}/projects/${row.id}/phases`),
      ]);
      setProfitability(r.data);
      setPhases(pr.data?.phases || []);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const addPhase = async () => {
    const name = newPhaseName.trim();
    if (!name || !activeProject) return;
    setPhaseBusy(true);
    try {
      await api.post(
        `/companies/${currentId}/projects/${activeProject.id}/phases`,
        { name });
      setNewPhaseName("");
      // Refresh both the phase list and the P&L rollup.
      await openProfitability(activeProject);
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
        `/companies/${currentId}/projects/${activeProject.id}/phases/${phaseId}`);
      toast.success("Phase deleted");
      await openProfitability(activeProject);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const turnOnProjects = async () => {
    try {
      await api.patch(`/companies/${currentId}/features`, {
        projects_enabled: true,
      });
      await refresh?.();
      toast.success("Projects enabled");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (!projectsEnabled) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4" data-testid="projects-disabled-empty">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-cyan-50 text-cyan-600">
          <Briefcase size={26} />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">Projects aren't enabled yet</h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Turn on Projects to track profitability per customer job — income,
          expenses, and labor rolled into one dashboard with Estimates vs
          Actuals.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <button onClick={turnOnProjects} data-testid="projects-enable-btn"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700">
            <Check size={14} /> Enable Projects
          </button>
          <button onClick={() => nav("/settings")}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50">
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6" data-testid="projects-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <Briefcase size={22} className="text-cyan-600" />
            Projects
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Track profitability for time-bound customer jobs at <span className="font-medium">{current?.name}</span>.
          </p>
        </div>
        <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showCancelled}
                  onChange={(e) => setShowCancelled(e.target.checked)}
                  data-testid="projects-show-cancelled" />
          Show cancelled
        </label>
      </div>

      {/* Quick-add row */}
      <div className="rounded-xl border bg-white p-4 grid grid-cols-12 gap-2 items-end" data-testid="projects-create-form">
        <div className="col-span-4">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Project name</label>
          <input value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Kitchen Remodel #23"
                  data-testid="projects-new-name"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-4">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Customer</label>
          <select value={form.contact_id}
                    onChange={(e) => setForm(f => ({ ...f, contact_id: e.target.value }))}
                    data-testid="projects-new-contact"
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500">
            <option value="">Pick a customer…</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="col-span-3">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Estimated revenue</label>
          <input type="number" step="0.01" value={form.estimated_revenue}
                  onChange={(e) => setForm(f => ({ ...f, estimated_revenue: e.target.value }))}
                  placeholder="0.00" data-testid="projects-new-estimate"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-1">
          <button onClick={create}
                    disabled={!form.name.trim() || !form.contact_id || creating}
                    data-testid="projects-create-btn"
                    className="w-full inline-flex items-center justify-center gap-1 px-3 py-2 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2 grid grid-cols-12 gap-2 text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b">
          <div className="col-span-4">Project · Customer</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-3 text-right">Est. revenue</div>
          <div className="col-span-3 text-right">Actions</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-slate-500 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No projects yet — create your first one above.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map(r => (
              <li key={r.id} className={`px-4 py-2.5 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 ${r.status === "cancelled" ? "opacity-60" : ""}`}
                  data-testid={`project-row-${r.id}`}>
                <button onClick={() => openProfitability(r)}
                        className="col-span-4 text-left min-w-0 hover:text-indigo-700"
                        data-testid={`project-open-${r.id}`}>
                  <div className="text-sm text-slate-900 truncate font-medium">{r.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {contactById[r.contact_id]?.name || r.contact_name || "—"}
                  </div>
                </button>
                <div className="col-span-2">
                  <select value={r.status}
                            onChange={(e) => setStatus(r, e.target.value)}
                            data-testid={`project-status-${r.id}`}
                            className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white text-slate-700 w-full">
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-3 text-right text-sm font-mono-num text-slate-700">
                  {r.estimated_revenue != null ? fmtMoney(r.estimated_revenue) : <span className="text-slate-300">—</span>}
                </div>
                <div className="col-span-3 flex justify-end gap-1">
                  <button onClick={() => openProfitability(r)}
                            data-testid={`project-view-${r.id}`}
                            className="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                    View
                  </button>
                  <button onClick={() => hardDelete(r)}
                            data-testid={`project-delete-${r.id}`}
                            className="p-1.5 rounded hover:bg-red-50 text-red-500"
                            title="Delete (only if unused)">
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Profitability drawer */}
      {activeProject && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setActiveProject(null)}>
          <div className="bg-white w-full max-w-xl h-full overflow-y-auto shadow-2xl p-5"
                onClick={(e) => e.stopPropagation()}
                data-testid="project-profitability-drawer">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500">Project profitability</div>
                <h2 className="font-heading text-xl font-bold text-slate-900">{activeProject.name}</h2>
                <div className="text-xs text-slate-500">
                  {contactById[activeProject.contact_id]?.name || activeProject.contact_name}
                </div>
              </div>
              <button onClick={() => setActiveProject(null)}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
                <X size={16} />
              </button>
            </div>
            {!profitability ? (
              <div className="text-center py-8 text-slate-500 text-sm">
                <Loader2 size={16} className="inline animate-spin mr-2" /> Computing…
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <MoneyRow label="Revenue" value={profitability.revenue.total} className="text-emerald-700 font-semibold" />
                <MoneyRow label="Cost of goods sold" value={-profitability.cogs.total} className="text-slate-700" />
                <MoneyRow label="Gross profit" value={profitability.gross_profit} className="text-slate-900 font-semibold border-t pt-2" />
                <MoneyRow label="Operating expenses" value={-profitability.expenses.total} className="text-slate-700" />
                <MoneyRow label="Net income" value={profitability.net_income}
                            className={`font-bold border-t pt-2 ${profitability.net_income >= 0 ? "text-emerald-700" : "text-rose-700"}`} />
                {profitability.estimated_revenue ? (
                  <div className="mt-4 rounded-lg bg-slate-50 p-3">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Estimate</div>
                    <div className="flex justify-between items-baseline mt-1">
                      <span className="text-sm text-slate-700">{fmtMoney(profitability.estimated_revenue)} est.</span>
                      <span className={`text-sm font-semibold ${profitability.pct_of_estimate >= 100 ? "text-emerald-700" : "text-slate-800"}`}>
                        {profitability.pct_of_estimate ?? 0}% earned
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div className="h-full bg-emerald-500 transition-all"
                            style={{ width: `${Math.min(100, profitability.pct_of_estimate ?? 0)}%` }} />
                    </div>
                  </div>
                ) : null}

                {/* --- Phases section (Feb 2026 Phase 3) --------------
                    Long jobs bucket their P&L by phase (Demo →
                    Framing → Finishes …). Postings on this project
                    without a phase_id roll under "Unphased". Rows
                    are draggable-by-sort_order via the +/- buttons
                    on each row (kept simple — no HTML5 drag/drop for
                    this pass). */}
                <div className="mt-6" data-testid="project-phases-section">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                      <LayersIcon size={12} /> Phases
                    </div>
                    <span className="text-[10px] text-slate-400">{phases.length}</span>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <input value={newPhaseName}
                            onChange={(e) => setNewPhaseName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") addPhase(); }}
                            placeholder="Add a phase (e.g. Framing)…"
                            data-testid="project-phase-new-input"
                            className="flex-1 border border-slate-300 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
                    <button onClick={addPhase}
                              disabled={!newPhaseName.trim() || phaseBusy}
                              data-testid="project-phase-add-btn"
                              className="inline-flex items-center px-2.5 py-1.5 rounded-md bg-cyan-600 text-white text-xs hover:bg-cyan-700 disabled:opacity-50">
                      {phaseBusy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    </button>
                  </div>
                  {(profitability.by_phase || []).length === 0 ? (
                    <div className="text-xs text-slate-400 italic py-2">
                      No phases yet — add one above and tag transactions to see per-phase P&amp;L.
                    </div>
                  ) : (
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                            <th className="text-left px-2 py-1.5">Phase</th>
                            <th className="text-right px-2 py-1.5">Revenue</th>
                            <th className="text-right px-2 py-1.5">Cost</th>
                            <th className="text-right px-2 py-1.5">Net</th>
                            <th className="w-6" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {(profitability.by_phase || []).map(ph => (
                            <tr key={ph.id || "_unphased_"}
                                data-testid={`project-phase-row-${ph.id || "_unphased_"}`}>
                              <td className="px-2 py-1.5">
                                <span className={ph.id ? "text-slate-800" : "italic text-slate-500"}>
                                  {ph.name}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono-num text-emerald-700">
                                {fmtMoney(ph.revenue)}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono-num text-slate-700">
                                {fmtMoney(ph.cogs + ph.expenses)}
                              </td>
                              <td className={`px-2 py-1.5 text-right font-mono-num font-semibold ${ph.net_income >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                                {fmtMoney(ph.net_income)}
                              </td>
                              <td className="text-right pr-1.5">
                                {ph.id && (
                                  <button onClick={() => deletePhase(ph.id)}
                                            className="p-1 rounded hover:bg-red-50 text-red-500"
                                            title="Delete (only if unused)"
                                            data-testid={`project-phase-delete-${ph.id}`}>
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MoneyRow({ label, value, className = "" }) {
  const fmt = useMoneyFmt();
  return (
    <div className={`flex justify-between items-baseline ${className}`}>
      <span>{label}</span>
      <span className="font-mono-num">{fmt(value)}</span>
    </div>
  );
}
