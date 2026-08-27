import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Plus, Loader2, Check, Trash2 } from "lucide-react";

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
    start_date: "", end_date: "",
  });
  const [creating, setCreating] = useState(false);
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

  const create = async () => {
    if (!form.name.trim() || !form.contact_id) return;
    setCreating(true);
    try {
      await api.post(`/companies/${currentId}/projects`, {
        name: form.name.trim(),
        contact_id: form.contact_id,
        estimated_revenue: form.estimated_revenue
          ? Number(form.estimated_revenue) : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      });
      setForm({ name: "", contact_id: "", estimated_revenue: "", start_date: "", end_date: "" });
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
        <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showCancelled}
                  onChange={(e) => setShowCancelled(e.target.checked)}
                  data-testid="projects-show-cancelled" />
          Show cancelled
        </label>
      </div>

      {/* Quick-add row */}
      <div className="rounded-xl border bg-white p-4 grid grid-cols-12 gap-2 items-end" data-testid="projects-create-form">
        <div className="col-span-3">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Project name</label>
          <input value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Kitchen Remodel #23"
                  data-testid="projects-new-name"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-3">
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
        <div className="col-span-2">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Estimated $</label>
          <input type="number" step="0.01" value={form.estimated_revenue}
                  onChange={(e) => setForm(f => ({ ...f, estimated_revenue: e.target.value }))}
                  placeholder="0.00" data-testid="projects-new-estimate"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-1.5" style={{ gridColumn: "span 2 / span 2" }}>
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Start</label>
          <input type="date" value={form.start_date}
                  onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                  data-testid="projects-new-start"
                  className="w-full border border-slate-300 rounded-md px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-1" style={{ gridColumn: "span 2 / span 2" }}>
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">End</label>
          <input type="date" value={form.end_date}
                  onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                  data-testid="projects-new-end"
                  className="w-full border border-slate-300 rounded-md px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
        <div className="col-span-12 flex justify-end">
          <button onClick={create}
                    disabled={!form.name.trim() || !form.contact_id || creating}
                    data-testid="projects-create-btn"
                    className="inline-flex items-center justify-center gap-1 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <><Plus size={14} /> Add project</>}
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
