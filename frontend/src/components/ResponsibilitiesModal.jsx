/**
 * ResponsibilitiesModal — edit the assignments after onboarding.
 *
 * Opened by the "Responsibilities" button on both the To Do page and
 * the Client Cockpit responsibilities panel. Loads the current state
 * on open, tracks local edits, saves via POST on Save.
 */
import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { X, Loader2, Save } from "lucide-react";
import ResponsibilitiesChecklist from "@/components/ResponsibilitiesChecklist";

export default function ResponsibilitiesModal({ companyId, open, onClose, onSaved }) {
  const [assignments, setAssignments] = useState({});
  const [payrollFrequency, setPayrollFrequency] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !companyId) return;
    setLoading(true);
    api.get(`/companies/${companyId}/responsibilities`)
      .then(r => {
        setAssignments(r.data.assignments || {});
        setPayrollFrequency(r.data.payroll_frequency || null);
      })
      .catch(e => toast.error(e?.response?.data?.detail || "Failed to load."))
      .finally(() => setLoading(false));
  }, [open, companyId]);

  const handleAssignmentChange = (key, val) => {
    setAssignments(prev => ({ ...prev, [key]: val }));
    if (key === "issuing_payroll" && !val) setPayrollFrequency(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/responsibilities`, {
        assignments,
        payroll_frequency: payrollFrequency,
      });
      toast.success("Responsibilities updated.");
      onSaved?.();
      onClose?.();
    } catch (e) {
      const d = e?.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Save failed — please review inputs.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6 overflow-y-auto" data-testid="responsibilities-modal">
      <div className="w-full max-w-2xl bg-white rounded-xl shadow-2xl my-6 overflow-hidden">
        <div className="px-5 py-3 border-b flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
              Responsibilities
            </div>
            <div className="font-semibold text-slate-900">Who does what each month?</div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            data-testid="responsibilities-modal-close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="py-10 flex items-center justify-center text-slate-400">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-3">
                For each monthly activity, pick who owns it. "Both" puts the item on both
                the accountant's Client Cockpit and the client's To Do page.
              </p>
              <ResponsibilitiesChecklist
                assignments={assignments}
                payrollFrequency={payrollFrequency}
                onAssignmentChange={handleAssignmentChange}
                onFrequencyChange={setPayrollFrequency}
              />
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50"
            data-testid="responsibilities-modal-cancel"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="responsibilities-modal-save"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
