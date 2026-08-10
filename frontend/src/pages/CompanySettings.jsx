import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Settings2, Save, Trash2, AlertTriangle, Loader2, Play, Sparkles } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { BUSINESS_TYPES } from "@/constants/businessTypes";

export default function CompanySettings() {
  const { currentId, current, refresh, companies } = useCompany();
  const nav = useNavigate();
  const [form, setForm] = useState({
    name: "", business_type: "", business_description: "", reporting_basis: "accrual",
    logo_data_url: "", address: "", phone: "", email: "", website: "", tax_id: "",
    accounting_mode: "simple",
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (current) {
      setForm({
        name: current.name || "",
        business_type: current.business_type || "",
        business_description: current.business_description || "",
        reporting_basis: current.reporting_basis || "accrual",
        logo_data_url: current.logo_data_url || "",
        address: current.address || "",
        phone: current.phone || "",
        email: current.email || "",
        website: current.website || "",
        tax_id: current.tax_id || "",
        accounting_mode: current.accounting_mode || "simple",
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
              <option value="">— Select entity type —</option>
              {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              {/* Legacy value support — if the stored value isn't in the
                  canonical list (older records used "LLC", "S-Corp", …),
                  keep it selectable so the field doesn't silently blank. */}
              {form.business_type && !BUSINESS_TYPES.includes(form.business_type) && (
                <option value={form.business_type}>
                  {form.business_type} (legacy)
                </option>
              )}
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

        {/* Accounting mode — hides/shows QBO-shaped entities. Kept as
            a full-width card so its consequences are obvious to the
            person flipping it (this is a per-company setting that
            changes the sidebar/toolbar for every user of the company). */}
        <div
          className="rounded-lg border border-slate-200 bg-slate-50/50 p-4"
          data-testid="settings-accounting-mode-card"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-slate-900">
                Accounting mode
              </h3>
              <p className="text-xs text-slate-600 mt-1 max-w-2xl">
                <b>Simple</b> keeps the app focused on bank feeds and AI
                categorization — best for business owners who just want
                clean books. <b>Advanced</b> unlocks the full QuickBooks
                toolkit: Sales Receipts, Credit Memos, Refund Receipts,
                and dedicated ledger views. Ideal for CPAs and
                bookkeepers running client books.
              </p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {[
                { v: "simple",   label: "Simple",   desc: "Bank feed + AI" },
                { v: "advanced", label: "Advanced", desc: "Full QBO parity" },
              ].map(({ v, label, desc }) => (
                <label
                  key={v}
                  className={`cursor-pointer flex items-start gap-2 px-3 py-2 rounded-md border transition-colors ${
                    form.accounting_mode === v
                      ? "bg-white border-slate-900 ring-1 ring-slate-900"
                      : "bg-white border-slate-200 hover:border-slate-300"
                  }`}
                  data-testid={`settings-accounting-mode-${v}`}
                >
                  <input
                    type="radio"
                    name="accounting_mode"
                    value={v}
                    checked={form.accounting_mode === v}
                    onChange={() => setForm({ ...form, accounting_mode: v })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900">{label}</div>
                    <div className="text-[11px] text-slate-500">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
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

        <div className="border-t pt-4 mt-2">
          <h3 className="font-heading font-semibold text-sm mb-1">Invoice &amp; bill branding</h3>
          <p className="text-xs text-slate-500 mb-3">These fields appear on the PDF header of every invoice, bill, and customer statement.</p>
          <div className="space-y-3">
            <Field label="Logo">
              <div className="flex items-center gap-3">
                {form.logo_data_url ? (
                  <img src={form.logo_data_url} alt="Logo preview" className="h-14 w-auto max-w-[180px] object-contain border rounded bg-white p-1" data-testid="settings-logo-preview" />
                ) : (
                  <div className="h-14 w-32 border border-dashed rounded flex items-center justify-center text-[10px] text-slate-400">No logo</div>
                )}
                <label className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-md border bg-white hover:bg-slate-50 cursor-pointer">
                  Upload
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    data-testid="settings-logo-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 200 * 1024) { toast.error("Logo too large. Max 200 KB."); return; }
                      const reader = new FileReader();
                      reader.onload = () => setForm({ ...form, logo_data_url: reader.result });
                      reader.readAsDataURL(f);
                    }}
                  />
                </label>
                {form.logo_data_url && (
                  <button type="button" onClick={() => setForm({ ...form, logo_data_url: "" })}
                          className="text-xs text-rose-600 hover:underline" data-testid="settings-logo-clear">Remove</button>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Address">
                <textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}
                          className="w-full border rounded-md px-3 py-2 text-sm resize-none"
                          placeholder="123 Main St, Suite 100&#10;Springfield, IL 62701"
                          data-testid="settings-address" />
              </Field>
              <div className="space-y-2">
                <Field label="Phone">
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                         placeholder="(555) 123-4567"
                         className="w-full border rounded-md px-3 py-2 text-sm" data-testid="settings-phone" />
                </Field>
                <Field label="Email">
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                         placeholder="billing@yourcompany.com"
                         className="w-full border rounded-md px-3 py-2 text-sm" data-testid="settings-email" />
                </Field>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Website">
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })}
                       placeholder="yourcompany.com"
                       className="w-full border rounded-md px-3 py-2 text-sm" data-testid="settings-website" />
              </Field>
              <Field label="Tax ID / EIN">
                <input value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
                       placeholder="12-3456789"
                       className="w-full border rounded-md px-3 py-2 text-sm" data-testid="settings-tax-id" />
              </Field>
            </div>
          </div>
        </div>

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

      {/* --- Tours & tips --- */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="settings-tours-card">
        <div className="flex items-start gap-2">
          <Sparkles size={18} className="text-cyan-600 mt-0.5" />
          <div>
            <h3 className="font-heading font-semibold text-lg">Tours &amp; tips</h3>
            <p className="text-sm text-slate-500 mt-1">
              Re-watch either onboarding tour any time — great for showing a
              teammate around, or just re-orienting yourself after a break.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            data-testid="settings-replay-welcome-btn"
            onClick={() => nav("/dashboard?replay=welcome")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-sm"
            title="Replay the welcome tour"
          >
            <Play size={13} /> Replay welcome tour
          </button>
          <button
            data-testid="settings-replay-post-tour-btn"
            onClick={() => nav("/dashboard?replay=post-tour")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-sm"
            title="Replay the after-onboarding dashboard tour"
          >
            <Play size={13} /> Replay dashboard tour
          </button>
          <button
            data-testid="settings-replay-step2-tour-btn"
            onClick={() => nav("/accounting/lets-review?tour=1&replay=1")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-sm"
            title="Replay the Step 2 (Let's Review) walkthrough"
          >
            <Play size={13} /> Replay Step 2 tour
          </button>
          <button
            data-testid="settings-replay-step3a-tour-btn"
            onClick={() => nav("/accounting/transfer-review?tour=1&replay=1")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-sm"
            title="Replay the Step 3A (Transfer Review) walkthrough"
          >
            <Play size={13} /> Replay Step 3A tour
          </button>
          <button
            data-testid="settings-replay-step3b-tour-btn"
            onClick={() => nav("/accounting/no-contact-review?tour=1&replay=1")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-sm"
            title="Replay the Step 3B (No-Contact Review) walkthrough"
          >
            <Play size={13} /> Replay Step 3B tour
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
