import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Plus, Loader2, Check, Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import ProjectFormModal from "@/components/ProjectFormModal";

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
  const [showForm, setShowForm] = useState(false);
  const nav = useNavigate();
  const openProject = (row) => nav(`/accounting/projects/${row.id}`);

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

  const create = async (payload) => {
    await api.post(`/companies/${currentId}/projects`, payload);
    toast.success("Project created");
    await load();
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

  const openProfitability = openProject;

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
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showCancelled}
                    onChange={(e) => setShowCancelled(e.target.checked)}
                    data-testid="projects-show-cancelled" />
            Show cancelled
          </label>
          <button onClick={() => setShowForm(true)}
                  data-testid="projects-new-btn"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700">
            <Plus size={14} /> New project
          </button>
        </div>
      </div>

      <ProjectFormModal
        open={showForm}
        onClose={() => setShowForm(false)}
        onSubmit={create}
        contacts={contacts}
      />

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
