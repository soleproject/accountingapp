import { useEffect, useState } from "react";
import { toast } from "sonner";
import { X, Loader2, Save } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * DealFormModal — create a new deal (Phase C, Feb 2026).
 * Reused inline from the Kanban's "New deal" button.
 */
export default function DealFormModal({ onClose, onSaved }) {
  const { currentId } = useCompany();
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    contact_id: "",
    value: "",
    stage: "lead",
    expected_close_date: "",
    source: "",
    notes: "",
  });

  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/contacts`);
        setContacts(r.data?.contacts || []);
      } catch { /* silent */ }
    })();
  }, [currentId]);

  const canSubmit = form.title.trim() && Number(form.value || 0) >= 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        contact_id: form.contact_id || null,
        value: Number(form.value || 0),
        stage: form.stage,
        expected_close_date: form.expected_close_date || null,
        source: form.source.trim() || null,
        notes: form.notes.trim(),
      };
      await api.post(`/companies/${currentId}/deals`, payload);
      toast.success("Deal created");
      onSaved?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center px-4"
          role="dialog" aria-modal="true"
          data-testid="deal-form-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-heading font-bold text-slate-900">New deal</div>
          <button onClick={onClose}
                  className="p-1 rounded hover:bg-slate-100 text-slate-400"
                  data-testid="deal-form-close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Title *">
            <input value={form.title}
                    onChange={(e) => setForm(f => ({...f, title: e.target.value}))}
                    placeholder="Website redesign + hosting"
                    data-testid="deal-form-title"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Contact">
              <select value={form.contact_id}
                        onChange={(e) => setForm(f => ({...f, contact_id: e.target.value}))}
                        data-testid="deal-form-contact"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
                <option value="">(none)</option>
                {contacts.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Stage">
              <select value={form.stage}
                        onChange={(e) => setForm(f => ({...f, stage: e.target.value}))}
                        data-testid="deal-form-stage"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
                {["lead","qualified","proposal","negotiation","won","lost"].map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Value ($)">
              <input type="number" step="0.01" min="0"
                      value={form.value}
                      onChange={(e) => setForm(f => ({...f, value: e.target.value}))}
                      placeholder="0.00"
                      data-testid="deal-form-value"
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            </Field>
            <Field label="Expected close">
              <input type="date"
                      value={form.expected_close_date}
                      onChange={(e) => setForm(f => ({...f, expected_close_date: e.target.value}))}
                      data-testid="deal-form-close-date"
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            </Field>
          </div>
          <Field label="Source (optional)">
            <input value={form.source}
                    onChange={(e) => setForm(f => ({...f, source: e.target.value}))}
                    placeholder="Referral · Cold outreach · Web"
                    data-testid="deal-form-source"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </Field>
          <Field label="Notes">
            <textarea value={form.notes}
                        onChange={(e) => setForm(f => ({...f, notes: e.target.value}))}
                        rows={3}
                        placeholder="Scope, key contacts, next steps…"
                        data-testid="deal-form-notes"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </Field>
        </div>
        <div className="px-4 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={onClose}
                  className="text-sm px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={submit}
                  disabled={!canSubmit || saving}
                  data-testid="deal-form-submit"
                  className="text-sm px-3 py-1.5 rounded bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Create
          </button>
        </div>
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
