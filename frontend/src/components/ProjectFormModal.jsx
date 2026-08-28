import { useEffect, useState } from "react";
import { X, Loader2, Briefcase, Plus, Check } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * Modal form for creating (and later editing) a Project. Kept as a
 * separate component so it can be reused from the Projects list page
 * AND from the ProjectDetail edit affordance later on.
 *
 * Props:
 *   - open (bool)
 *   - onClose()
 *   - onSubmit(payload)           — awaits, caller handles the API call
 *   - contacts: [{id, name}]      — customer picker options
 *   - initial (optional)          — pre-fills fields for edit mode
 *   - title (optional)            — override modal title
 */
export default function ProjectFormModal({
  open, onClose, onSubmit, contacts,
  initial = null, title,
}) {
  const { currentId } = useCompany();
  const [form, setForm] = useState(makeBlank());
  const [saving, setSaving] = useState(false);
  const [types, setTypes] = useState(["General"]);
  const [addingType, setAddingType] = useState(false);
  const [newType, setNewType] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(initial ? {
      name: initial.name || "",
      contact_id: initial.contact_id || "",
      project_type: initial.project_type || "General",
      estimated_revenue: initial.estimated_revenue ?? "",
      start_date: initial.start_date || "",
      end_date: initial.end_date || "",
      notes: initial.notes || "",
    } : makeBlank());
    setSaving(false);
    setAddingType(false);
    setNewType("");
  }, [open, initial]);

  // Load saved project types the moment the modal opens.
  useEffect(() => {
    if (!open || !currentId) return;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/project-types`);
        setTypes(r.data?.types || ["General"]);
      } catch { /* silent — "General" default is fine */ }
    })();
  }, [open, currentId]);

  const saveNewType = async () => {
    const n = newType.trim();
    if (!n) return;
    try {
      const r = await api.post(`/companies/${currentId}/project-types`,
        { name: n });
      setTypes(r.data?.types || types);
      setForm(f => ({ ...f, project_type: n }));
      setAddingType(false);
      setNewType("");
    } catch (e) {
      // Toast is handled by API layer; keep the input open so the
      // user can tweak the value.
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  const canSubmit = !!form.name.trim() && !!form.contact_id && !saving;
  const dateInvalid = form.start_date && form.end_date && form.end_date < form.start_date;

  const submit = async () => {
    if (!canSubmit || dateInvalid) return;
    setSaving(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        contact_id: form.contact_id,
        project_type: form.project_type || "General",
        estimated_revenue: form.estimated_revenue === ""
          ? null : Number(form.estimated_revenue),
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        notes: form.notes.trim(),
      });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          role="dialog" aria-modal="true"
          data-testid="project-form-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
            onClick={() => !saving && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center">
              <Briefcase size={15} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">
                {title || (initial ? "Edit project" : "New project")}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Kitchen Remodel · Q3 Marketing Blitz · Roof Repair #14
              </div>
            </div>
          </div>
          <button onClick={() => !saving && onClose()}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  data-testid="project-form-close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <Field label="Project name" required>
            <input value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Kitchen Remodel #23"
                    autoFocus
                    data-testid="project-form-name"
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
          </Field>

          <Field label="Customer" required>
            <select value={form.contact_id}
                      onChange={(e) => setForm(f => ({ ...f, contact_id: e.target.value }))}
                      data-testid="project-form-contact"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-cyan-500">
              <option value="">Pick a customer…</option>
              {contacts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Type">
            {addingType ? (
              <div className="flex items-center gap-1">
                <input value={newType}
                        onChange={(e) => setNewType(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); saveNewType(); }
                          if (e.key === "Escape") { setAddingType(false); setNewType(""); }
                        }}
                        autoFocus
                        placeholder="e.g. Construction"
                        maxLength={40}
                        data-testid="project-form-new-type"
                        className="flex-1 border border-cyan-400 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
                <button onClick={saveNewType}
                        type="button"
                        data-testid="project-form-new-type-save"
                        disabled={!newType.trim()}
                        className="px-3 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700 disabled:opacity-40 inline-flex items-center gap-1">
                  <Check size={13} /> Save
                </button>
                <button onClick={() => { setAddingType(false); setNewType(""); }}
                        type="button"
                        className="px-2 py-2 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100">
                  <X size={13} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <select value={form.project_type}
                          onChange={(e) => setForm(f => ({ ...f, project_type: e.target.value }))}
                          data-testid="project-form-type"
                          className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-cyan-500">
                  {types.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button onClick={() => setAddingType(true)}
                        type="button"
                        data-testid="project-form-add-type"
                        title="Add a new type — saves for future projects"
                        className="px-3 py-2 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-cyan-700 inline-flex items-center gap-1 text-sm">
                  <Plus size={13} /> New
                </button>
              </div>
            )}
          </Field>

          <Field label="Estimated $">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input type="number" step="0.01"
                      value={form.estimated_revenue}
                      onChange={(e) => setForm(f => ({ ...f, estimated_revenue: e.target.value }))}
                      placeholder="0.00"
                      data-testid="project-form-estimate"
                      className="w-full border border-slate-300 rounded-md pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            </div>
            <div className="text-[10px] text-slate-500 mt-1 italic">
              Powers the Estimates vs Actuals report. Leave blank for open-scope work.
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              <input type="date" value={form.start_date}
                      onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                      data-testid="project-form-start"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            </Field>
            <Field label="End date">
              <input type="date" value={form.end_date}
                      onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                      data-testid="project-form-end"
                      className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 ${dateInvalid ? "border-rose-400" : "border-slate-300"}`} />
            </Field>
          </div>
          {dateInvalid && (
            <div className="text-[11px] text-rose-600 -mt-2">End date is before start date.</div>
          )}

          <Field label="Notes / description">
            <textarea value={form.notes}
                        onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                        rows={3}
                        placeholder="Scope, key contacts, unusual terms — anything the PM should remember."
                        data-testid="project-form-notes"
                        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 resize-y" />
          </Field>
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={() => !saving && onClose()}
                    disabled={saving}
                    className="text-sm px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={submit}
                    disabled={!canSubmit || dateInvalid}
                    data-testid="project-form-submit"
                    className="text-sm px-4 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            {initial ? "Save changes" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function makeBlank() {
  return {
    name: "", contact_id: "", project_type: "General",
    estimated_revenue: "",
    start_date: "", end_date: "", notes: "",
  };
}
