import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Settings2, Save, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const BUSINESS_TYPES = [
  "LLC", "S-Corp", "C-Corp", "Sole Proprietor", "Partnership", "Non-profit", "Other",
];

export default function CompanySettings() {
  const { currentId, current, refresh, companies } = useCompany();
  const nav = useNavigate();
  const [form, setForm] = useState({
    name: "", business_type: "LLC", business_description: "", reporting_basis: "accrual",
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (current) {
      setForm({
        name: current.name || "",
        business_type: current.business_type || "LLC",
        business_description: current.business_description || "",
        reporting_basis: current.reporting_basis || "accrual",
      });
    }
  }, [current]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/companies/${currentId}`, form);
      toast.success("Company settings saved");
      await refresh();
    } catch (e) {
      toast.error(`Save failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const doDelete = async () => {
    if (confirmName !== current?.name) {
      toast.error("The confirmation name doesn't match.");
      return;
    }
    setDeleting(true);
    try {
      const r = await api.delete(`/companies/${currentId}`, {
        params: { confirm: current.name },
      });
      const rec = r.data.records_removed || {};
      const total = Object.values(rec).reduce((a, b) => a + b, 0);
      toast.success(`Deleted "${current.name}" and ${total} associated record(s).`);
      localStorage.removeItem("axiom_company_id");
      setDialogOpen(false);
      await refresh();
      // Switch to another company if available, otherwise home
      const others = (companies || []).filter(c => c.id !== currentId);
      if (others.length > 0) {
        localStorage.setItem("axiom_company_id", others[0].id);
        nav("/dashboard", { replace: true });
        window.location.reload();
      } else {
        nav("/", { replace: true });
      }
    } catch (e) {
      toast.error(`Delete failed: ${e.response?.data?.detail || e.message}`);
    } finally { setDeleting(false); }
  };

  if (!currentId) {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Select a company from the top-left dropdown first.
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
          <Settings2 size={22} className="text-cyan-600" />
          Company Settings
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Manage <span className="font-medium">{current?.name}</span>&apos;s profile and lifecycle.
        </p>
      </div>

      {/* --- Profile card --- */}
      <div className="rounded-xl border bg-white p-5 space-y-4">
        <h3 className="font-heading font-semibold text-lg">Profile</h3>

        <Field label="Company name">
          <input
            data-testid="settings-name-input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Business type">
            <select
              data-testid="settings-business-type"
              value={form.business_type}
              onChange={(e) => setForm({ ...form, business_type: e.target.value })}
              className="w-full border rounded-md px-3 py-2 text-sm bg-white"
            >
              {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Reporting basis">
            <select
              data-testid="settings-reporting-basis"
              value={form.reporting_basis}
              onChange={(e) => setForm({ ...form, reporting_basis: e.target.value })}
              className="w-full border rounded-md px-3 py-2 text-sm bg-white"
            >
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </Field>
        </div>

        <Field label="Business description">
          <textarea
            data-testid="settings-business-description"
            value={form.business_description}
            onChange={(e) => setForm({ ...form, business_description: e.target.value })}
            rows={3}
            className="w-full border rounded-md px-3 py-2 text-sm resize-none"
            placeholder="What does this business do? (used by AI to tailor categorization)"
          />
        </Field>

        <div className="pt-2 flex items-center gap-2">
          <button
            data-testid="settings-save-btn"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm rounded-md hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save changes
          </button>
        </div>
      </div>

      {/* --- Danger zone --- */}
      <div className="rounded-xl border border-red-200 bg-red-50/40 p-5 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={18} className="text-red-600 mt-0.5" />
          <div>
            <h3 className="font-heading font-semibold text-lg text-red-800">Danger zone</h3>
            <p className="text-sm text-red-700/80 mt-1">
              Deleting a company is <span className="font-semibold">permanent</span> and cannot be
              undone. Every transaction, invoice, bill, journal entry, chart-of-accounts entry,
              Plaid link, Veryfi upload, rule, and audit log for this company will be removed.
            </p>
          </div>
        </div>

        <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <AlertDialogTrigger asChild>
            <button
              data-testid="settings-delete-company-btn"
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700"
            >
              <Trash2 size={14} />
              Delete this company
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete &quot;{current?.name}&quot;?</AlertDialogTitle>
              <AlertDialogDescription>
                This action is <span className="font-semibold text-red-700">permanent</span>. To
                confirm, type the company name below exactly as shown:
                <div className="mt-2 mb-1 font-mono-num text-slate-900">{current?.name}</div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <input
              data-testid="settings-delete-confirm-input"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoFocus
              className="w-full border border-red-300 rounded-md px-3 py-2 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-red-400"
              placeholder="Type company name to confirm"
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting} onClick={() => setConfirmName("")}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="settings-delete-confirm-btn"
                onClick={(e) => { e.preventDefault(); doDelete(); }}
                disabled={deleting || confirmName !== current?.name}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? (<><Loader2 size={14} className="animate-spin mr-2" />Deleting…</>) : "Permanently delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1 font-semibold">{label}</div>
      {children}
    </label>
  );
}
