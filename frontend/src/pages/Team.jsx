import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Building2, Plus, Loader2, Edit2, Archive, ArchiveRestore, X,
  Sparkles, Circle,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import NotesBlock from "@/components/NotesBlock";

/**
 * Team — the Employees directory page (Phase B-1, Feb 2026).
 *
 * Shows every employee at the current company with their role,
 * department, cost rate, and permission summary. Owner can create
 * new employees, edit existing ones, and archive/restore.
 */
const ROLE_LABELS = {
  owner: "Owner",
  manager: "Manager",
  bookkeeper: "Bookkeeper",
  field_employee: "Field employee",
};
const ROLE_COLORS = {
  owner:          "bg-amber-50   text-amber-800   border-amber-200",
  manager:        "bg-violet-50  text-violet-700  border-violet-200",
  bookkeeper:     "bg-cyan-50    text-cyan-700    border-cyan-200",
  field_employee: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export default function Team() {
  const { currentId, current } = useCompany();
  const fmt = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // {mode:"create"|"edit", employee?}

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/employees?include_inactive=${showInactive}`);
      setRows(r.data?.employees || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, showInactive]);

  const archive = async (emp) => {
    if (!confirm(`Archive ${emp.name}?`)) return;
    try {
      await api.delete(`/companies/${currentId}/employees/${emp.id}`);
      toast.success("Archived");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const restore = async (emp) => {
    try {
      await api.patch(`/companies/${currentId}/employees/${emp.id}`,
        { active: true });
      toast.success("Restored");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="max-w-5xl space-y-6" data-testid="team-page">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <Building2 size={22} className="text-emerald-600" />
            Employees
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Directory of everyone on the {current?.name} team. Each has a role that determines default product access.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showInactive}
                    onChange={(e) => setShowInactive(e.target.checked)}
                    data-testid="team-show-inactive" />
            Show archived
          </label>
          <button onClick={() => setEditing({ mode: "create" })}
                  data-testid="team-new-btn"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
            <Plus size={14} /> New employee
          </button>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2 grid grid-cols-12 gap-2 text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b">
          <div className="col-span-3">Name</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-3">Title · Dept</div>
          <div className="col-span-2 text-right">Cost / hr</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-slate-500 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            No {showInactive ? "" : "active "}employees yet.
            <div className="text-xs text-slate-400 italic mt-1">
              Click <b>New employee</b> to add your first teammate.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="team-list">
            {rows.map(e => (
              <li key={e.id}
                  className={`px-4 py-2.5 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 ${e.active === false ? "opacity-60" : ""}`}
                  data-testid={`team-row-${e.id}`}>
                <div className="col-span-3 min-w-0">
                  <div className="text-sm text-slate-900 truncate font-medium">
                    {e.name}
                    {e.active === false && (
                      <span className="ml-1 text-[9px] uppercase tracking-wider text-slate-400 bg-slate-100 border border-slate-200 rounded px-1">archived</span>
                    )}
                  </div>
                  {e.email && <div className="text-[11px] text-slate-500 truncate">{e.email}</div>}
                </div>
                <div className="col-span-2">
                  <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider border rounded px-1.5 py-0.5 ${ROLE_COLORS[e.role] || "bg-slate-100 border-slate-200 text-slate-700"}`}>
                    <Circle size={6} fill="currentColor" />
                    {ROLE_LABELS[e.role] || e.role}
                  </span>
                </div>
                <div className="col-span-3 text-xs text-slate-600 truncate">
                  {e.title || <span className="text-slate-300">—</span>}
                  {e.department && (
                    <span className="text-slate-400"> · {e.department}</span>
                  )}
                </div>
                <div className="col-span-2 text-right text-sm font-mono-num text-slate-700">
                  {e.hourly_cost_rate != null
                    ? fmt(e.hourly_cost_rate)
                    : <span className="text-slate-300">—</span>}
                </div>
                <div className="col-span-2 flex justify-end gap-1">
                  <button onClick={() => setEditing({ mode: "edit", employee: e })}
                            data-testid={`team-edit-${e.id}`}
                            className="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1">
                    <Edit2 size={11} /> Edit
                  </button>
                  {e.active === false ? (
                    <button onClick={() => restore(e)}
                              title="Restore"
                              data-testid={`team-restore-${e.id}`}
                              className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600">
                      <ArchiveRestore size={13} />
                    </button>
                  ) : (
                    <button onClick={() => archive(e)}
                              title="Archive"
                              data-testid={`team-archive-${e.id}`}
                              className="p-1.5 rounded hover:bg-red-50 text-red-500">
                      <Archive size={13} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="text-[11px] text-slate-500 italic">
        <Sparkles size={11} className="inline mr-1 text-slate-400" />
        Time tracking now lives at <b>Team → Time</b>. Coming next in Phase B-3: team calendar view aggregating tasks + hours by teammate.
      </div>

      {editing && (
        <EmployeeFormModal
          open onClose={() => setEditing(null)}
          initial={editing.mode === "edit" ? editing.employee : null}
          onSaved={async () => { setEditing(null); await load(); }}
          companyId={currentId}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Employee create/edit modal
// ------------------------------------------------------------------
function EmployeeFormModal({ open, onClose, initial, onSaved, companyId }) {
  const [form, setForm] = useState(() => makeForm(initial));
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("details"); // "details" | "permissions" | "notes"
  const [perms, setPerms] = useState(null); // {role, role_defaults, overrides, effective}
  const [permsSaving, setPermsSaving] = useState(false);
  const isEdit = !!initial;

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  useEffect(() => {
    if (!open || !isEdit) return;
    // Load effective permissions once the modal opens in edit mode.
    api.get(`/companies/${companyId}/employees/${initial.id}/permissions`)
      .then(r => setPerms(r.data))
      .catch(() => setPerms(null));
  }, [open, isEdit, companyId, initial?.id]);

  if (!open) return null;

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        role: form.role,
        title: form.title.trim() || null,
        department: form.department.trim() || null,
        hourly_cost_rate: form.hourly_cost_rate === ""
          ? null : Number(form.hourly_cost_rate),
        notes: form.notes.trim(),
      };
      if (isEdit) {
        await api.patch(`/companies/${companyId}/employees/${initial.id}`, payload);
        toast.success("Employee updated");
      } else {
        await api.post(`/companies/${companyId}/employees`, payload);
        toast.success("Employee added");
      }
      onSaved?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          role="dialog" aria-modal="true"
          data-testid="employee-form-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
            onClick={() => !saving && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Building2 size={15} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">
                {isEdit ? `Edit ${initial.name}` : "New employee"}
              </div>
            </div>
          </div>
          <button onClick={() => !saving && onClose()}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  data-testid="employee-form-close">
            <X size={16} />
          </button>
        </div>
        {isEdit && (
          <div className="px-5 pt-3 flex gap-1 border-b -mb-px bg-white" data-testid="employee-modal-tabs">
            <TabBtn active={tab === "details"}     onClick={() => setTab("details")}     label="Details"     testId="employee-tab-details" />
            <TabBtn active={tab === "permissions"} onClick={() => setTab("permissions")} label="Permissions" testId="employee-tab-permissions" />
            <TabBtn active={tab === "notes"}       onClick={() => setTab("notes")}       label="Notes"       testId="employee-tab-notes" />
          </div>
        )}
        <div className="p-5 space-y-3 overflow-y-auto">
          {(!isEdit || tab === "details") && (
          <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name" required className="col-span-2">
              <input value={form.name}
                      onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Sarah Kim" autoFocus
                      data-testid="employee-form-name"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email}
                      onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="sarah@company.com"
                      data-testid="employee-form-email"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </Field>
            <Field label="Phone">
              <input value={form.phone}
                      onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
                      placeholder="(555) 123-4567"
                      data-testid="employee-form-phone"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </Field>
            <Field label="Role" required>
              <select value={form.role}
                        onChange={(e) => setForm(f => ({ ...f, role: e.target.value }))}
                        data-testid="employee-form-role"
                        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500">
                {Object.entries(ROLE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Cost / hour">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                <input type="number" step="0.01" value={form.hourly_cost_rate}
                        onChange={(e) => setForm(f => ({ ...f, hourly_cost_rate: e.target.value }))}
                        placeholder="0.00"
                        data-testid="employee-form-rate"
                        className="w-full border border-slate-300 rounded-md pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              </div>
            </Field>
            <Field label="Title">
              <input value={form.title}
                      onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                      placeholder="Foreman · PM · Bookkeeper"
                      data-testid="employee-form-title"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </Field>
            <Field label="Department">
              <input value={form.department}
                      onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))}
                      placeholder="Field · Office · Admin"
                      data-testid="employee-form-dept"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </Field>
            <Field label="Notes" className="col-span-2">
              <textarea value={form.notes}
                          onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                          rows={2}
                          placeholder="Emergency contact · certifications · anything worth remembering."
                          data-testid="employee-form-notes"
                          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-y" />
            </Field>
          </div>
          <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-3 text-[11px] text-emerald-900">
            <b className="uppercase tracking-wider text-[10px]">Role defaults</b> — determines default product access:
            <RoleAccessHint role={form.role} />
          </div>
          </>
          )}

          {isEdit && tab === "permissions" && (
            <PermissionGrid
              perms={perms}
              saving={permsSaving}
              onToggle={async (product, value) => {
                setPermsSaving(true);
                try {
                  const nextOverrides = { ...(perms?.overrides || {}) };
                  // Toggle logic: clicking a toggle sets an explicit
                  // override. Clicking the "revert to default" X clears it.
                  if (value === null) delete nextOverrides[product];
                  else nextOverrides[product] = value;
                  await api.patch(
                    `/companies/${companyId}/employees/${initial.id}`,
                    { permission_overrides: nextOverrides });
                  // Refresh effective perms.
                  const r = await api.get(
                    `/companies/${companyId}/employees/${initial.id}/permissions`);
                  setPerms(r.data);
                  toast.success("Permissions updated");
                } catch (e) {
                  toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
                } finally { setPermsSaving(false); }
              }}
            />
          )}

          {isEdit && tab === "notes" && (
            <NotesBlock
              entityType="employee"
              entityId={initial.id}
              compact
            />
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={() => !saving && onClose()}
                    disabled={saving}
                    className="text-sm px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={submit}
                    disabled={!form.name.trim() || saving}
                    data-testid="employee-form-submit"
                    className="text-sm px-4 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            {isEdit ? "Save changes" : "Add employee"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label, testId }) {
  return (
    <button onClick={onClick}
            data-testid={testId}
            className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition ${
              active
                ? "border-emerald-600 text-emerald-700 font-medium"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}>
      {label}
    </button>
  );
}

const PRODUCT_META = [
  { key: "accounting", label: "Accounting", desc: "GL, transactions, reports, invoices, bills" },
  { key: "crm",        label: "CRM",        desc: "Deals, pipeline, contacts, activities" },
  { key: "team",       label: "Team",       desc: "Employees, tasks, time tracking" },
  { key: "projects",   label: "Projects",   desc: "Job costing, phases, project P&L" },
];

function PermissionGrid({ perms, saving, onToggle }) {
  if (!perms) {
    return (
      <div className="text-center py-6 text-slate-500 text-sm">
        <Loader2 size={14} className="inline animate-spin mr-1" /> Loading permissions…
      </div>
    );
  }
  const { role_defaults, overrides, effective } = perms;
  return (
    <div className="space-y-3" data-testid="employee-permissions-grid">
      <div className="text-[11px] text-slate-600">
        Overrides layer on top of role defaults. Effective = default unless the row shows an override; positive is good.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b">
            <th className="text-left py-2">Product</th>
            <th className="text-center py-2 w-24">Role default</th>
            <th className="text-center py-2 w-28">Override</th>
            <th className="text-center py-2 w-24">Effective</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {PRODUCT_META.map(p => {
            const def = !!role_defaults?.[p.key];
            const hasOverride = Object.prototype.hasOwnProperty.call(overrides || {}, p.key);
            const ov = overrides?.[p.key];
            const eff = !!effective?.[p.key];
            return (
              <tr key={p.key} data-testid={`perm-row-${p.key}`}>
                <td className="py-2.5">
                  <div className="font-medium text-slate-800">{p.label}</div>
                  <div className="text-[10px] text-slate-500">{p.desc}</div>
                </td>
                <td className="text-center">
                  <YesNoDot on={def} muted />
                </td>
                <td className="text-center">
                  <div className="inline-flex items-center gap-1">
                    <button onClick={() => onToggle(p.key, true)}
                              disabled={saving}
                              data-testid={`perm-allow-${p.key}`}
                              className={`text-[10px] px-2 py-0.5 rounded border ${
                                hasOverride && ov === true
                                  ? "bg-emerald-600 border-emerald-600 text-white"
                                  : "border-slate-200 text-slate-500 hover:bg-slate-50"
                              }`}>Allow</button>
                    <button onClick={() => onToggle(p.key, false)}
                              disabled={saving}
                              data-testid={`perm-deny-${p.key}`}
                              className={`text-[10px] px-2 py-0.5 rounded border ${
                                hasOverride && ov === false
                                  ? "bg-rose-600 border-rose-600 text-white"
                                  : "border-slate-200 text-slate-500 hover:bg-slate-50"
                              }`}>Deny</button>
                    {hasOverride && (
                      <button onClick={() => onToggle(p.key, null)}
                                disabled={saving}
                                title="Revert to role default"
                                data-testid={`perm-revert-${p.key}`}
                                className="text-[10px] p-0.5 rounded text-slate-400 hover:text-slate-700">
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </td>
                <td className="text-center">
                  <YesNoDot on={eff} strong={hasOverride} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {saving && (
        <div className="text-[10px] text-slate-500 italic text-center">
          <Loader2 size={10} className="inline animate-spin mr-1" /> Saving…
        </div>
      )}
    </div>
  );
}

function YesNoDot({ on, muted, strong }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ${
      on
        ? (strong ? "bg-emerald-600 text-white" : muted ? "bg-emerald-100 text-emerald-700" : "bg-emerald-500 text-white")
        : (strong ? "bg-rose-600 text-white"     : muted ? "bg-slate-100 text-slate-500"     : "bg-rose-500 text-white")
    }`}>
      {on ? "✓" : "—"}
    </span>
  );
}

function RoleAccessHint({ role }) {
  const perms = {
    owner:          "Accounting · CRM · Team · Projects — everything",
    manager:        "Accounting · CRM · Team · Projects — everything except firm-level pages",
    bookkeeper:     "Accounting only",
    field_employee: "Team · Projects — no accounting or CRM",
  };
  return (
    <div className="mt-0.5 text-slate-700">{perms[role] || perms.field_employee}</div>
  );
}

function Field({ label, required, className = "", children }) {
  return (
    <div className={className}>
      <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function makeForm(e) {
  if (!e) return {
    name: "", email: "", phone: "", role: "field_employee",
    title: "", department: "", hourly_cost_rate: "", notes: "",
  };
  return {
    name: e.name || "", email: e.email || "", phone: e.phone || "",
    role: e.role || "field_employee",
    title: e.title || "", department: e.department || "",
    hourly_cost_rate: e.hourly_cost_rate ?? "", notes: e.notes || "",
  };
}
