import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Clock } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * TimeEntryForm — inline "log time" form (Phase B-3, Feb 2026).
 *
 * Props:
 *   defaultProjectId, defaultPhaseId, defaultEmployeeId — pre-fill
 *   lockedProjectId (bool) — when true, project select is disabled
 *      (used on Project detail's Time tab).
 *   onSaved(entry) — invoked after successful POST.
 *
 * The form loads the caller's employee list + projects internally
 * so it can be dropped anywhere without prop drilling.
 */
export default function TimeEntryForm({
  defaultProjectId = null,
  defaultPhaseId = null,
  defaultEmployeeId = null,
  lockedProjectId = false,
  onSaved,
}) {
  const { currentId } = useCompany();
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);
  const [phases, setPhases] = useState([]);
  const [saving, setSaving] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    employee_id: defaultEmployeeId || "",
    project_id: defaultProjectId || "",
    phase_id: defaultPhaseId || "",
    date: today,
    hours: "",
    billable: true,
    notes: "",
  });

  // Load employees + projects once.
  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const [emp, proj] = await Promise.all([
          api.get(`/companies/${currentId}/employees`),
          api.get(`/companies/${currentId}/projects`),
        ]);
        setEmployees(emp.data?.employees || []);
        setProjects((proj.data?.projects || []).filter(p => p.active !== false));
        // Auto-pick if there's only one employee & no default supplied.
        setForm(f => {
          const next = { ...f };
          if (!next.employee_id && emp.data?.employees?.length === 1) {
            next.employee_id = emp.data.employees[0].id;
          }
          return next;
        });
      } catch (e) {
        toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
      }
    })();
  }, [currentId]);

  // Load phases whenever the selected project changes.
  useEffect(() => {
    if (!currentId || !form.project_id) { setPhases([]); return; }
    (async () => {
      try {
        const r = await api.get(
          `/companies/${currentId}/projects/${form.project_id}/phases`);
        setPhases(r.data?.phases || []);
      } catch { /* silent — phases are optional */ }
    })();
  }, [currentId, form.project_id]);

  const canSubmit = form.employee_id && form.project_id && form.date &&
                    Number(form.hours) > 0 && Number(form.hours) <= 24;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const payload = {
        employee_id: form.employee_id,
        project_id: form.project_id,
        phase_id: form.phase_id || null,
        date: form.date,
        hours: Number(form.hours),
        billable: !!form.billable,
        notes: form.notes.trim(),
      };
      const r = await api.post(
        `/companies/${currentId}/time-entries`, payload);
      toast.success(`Logged ${payload.hours}h`);
      // Reset hours + notes but keep the rest so it's easy to log a chain.
      setForm(f => ({ ...f, hours: "", notes: "" }));
      onSaved?.(r.data?.time_entry);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="rounded-xl border bg-white p-4 space-y-3"
          data-testid="time-entry-form">
      <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
        <Clock size={13} className="text-emerald-600" /> Log time
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Field label="Employee">
          <select value={form.employee_id}
                    onChange={(e) => setForm(f => ({ ...f, employee_id: e.target.value }))}
                    data-testid="time-form-employee"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
            <option value="">— pick —</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select value={form.project_id}
                    disabled={lockedProjectId}
                    onChange={(e) => setForm(f => ({
                      ...f, project_id: e.target.value, phase_id: ""}))}
                    data-testid="time-form-project"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white disabled:bg-slate-50 disabled:text-slate-500">
            <option value="">— pick —</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Phase">
          <select value={form.phase_id}
                    onChange={(e) => setForm(f => ({ ...f, phase_id: e.target.value }))}
                    disabled={!form.project_id || phases.length === 0}
                    data-testid="time-form-phase"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white disabled:bg-slate-50 disabled:text-slate-400">
            <option value="">(none)</option>
            {phases.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={form.date}
                  onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))}
                  data-testid="time-form-date"
                  className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white" />
        </Field>
        <Field label="Hours">
          <input type="number" step="0.25" min="0" max="24"
                  value={form.hours}
                  onChange={(e) => setForm(f => ({ ...f, hours: e.target.value }))}
                  placeholder="0.0"
                  data-testid="time-form-hours"
                  className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white" />
        </Field>
        <Field label="Billable">
          <label className="flex items-center gap-1.5 text-xs text-slate-700 h-[34px]">
            <input type="checkbox" checked={form.billable}
                    onChange={(e) => setForm(f => ({ ...f, billable: e.target.checked }))}
                    data-testid="time-form-billable"
                    className="rounded border-slate-300" />
            Billable
          </label>
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
        <Field label="Notes (optional)">
          <input value={form.notes}
                  onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="What did you work on?"
                  data-testid="time-form-notes"
                  className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
        </Field>
        <button onClick={submit}
                  disabled={!canSubmit || saving}
                  data-testid="time-form-submit"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Log time
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">
        {label}
      </label>
      {children}
    </div>
  );
}
