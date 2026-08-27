import { useEffect, useState } from "react";
import React from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Settings2, Save, Trash2, AlertTriangle, Loader2, Play, Sparkles, Copy } from "lucide-react";
import { IndustryTemplatePicker, CategorizationModeToggle } from "@/components/AIFirstControls";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { BUSINESS_TYPES } from "@/constants/businessTypes";
import QboEnvToggle from "@/components/QboEnvToggle";

/**
 * Normalize a company-name string for comparison purposes.
 *
 * Legacy names from early onboarding sometimes carry non-breaking
 * spaces (`\u00A0`) or double regular spaces that the user cannot
 * reliably reproduce from their keyboard when confirming a delete.
 * Trim, then replace any run of whitespace (regular + non-breaking +
 * tab) with a single ASCII space so the disabled-check compares
 * canonical forms only. Character content (letters, digits,
 * punctuation, casing) still has to match — only whitespace shape is
 * forgiven.
 */
function normName(s) {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

export default function CompanySettings() {
  const { currentId, current, refresh, companies } = useCompany();
  const nav = useNavigate();
  const [form, setForm] = useState({
    name: "", business_type: "", business_description: "", reporting_basis: "accrual",
    logo_data_url: "", address: "", phone: "", email: "", website: "", tax_id: "",
    accounting_mode: "simple",
    report_style: null,   // per-company report styling; see DEFAULT_REPORT_STYLE on the backend
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  // Tabbed layout state — persisted in localStorage so the Pro
  // doesn't have to re-navigate to their preferred tab on every reload.
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem("axiom_settings_tab") || "bookkeeping"; }
    catch { return "bookkeeping"; }
  });
  const goTab = (k) => {
    setTab(k);
    try { localStorage.setItem("axiom_settings_tab", k); } catch {}
  };

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
        report_style: current.report_style || null,
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
    // Compare AFTER normalizing whitespace on both sides: trim, then
    // collapse any run of whitespace (regular spaces, non-breaking
    // spaces `\u00A0`, tabs, etc.) into a single ASCII space. Legacy
    // company names sometimes include NBSPs from copy-paste or from
    // early onboarding flows — the user cannot reliably reproduce
    // those from their keyboard, so a strict `!==` comparison would
    // leave them unable to delete a real company (as happened with
    // "QBO 14 LLC"). This still requires the user to type the name
    // character-for-character (spelling, casing, punctuation) — only
    // whitespace shape is forgiven.
    if (normName(confirmName) !== normName(current?.name)) {
      toast.error("The confirmation name doesn't match.");
      return;
    }
    setDeleting(true);
    try {
      const params = { confirm: current.name };
      // Firm Books companies need an explicit override flag on the
      // server (see routes/companies.py::delete_company). The confirm-
      // by-typing-the-name step already provides the "did you really
      // mean this" gate, so we just add the flag here rather than
      // stacking another dialog on top.
      if (current?.is_firm_books) params.force_firm_books = true;
      // Same rationale for Partner Books — different flag so a firm-
      // books override can't accidentally bypass a partner-books row.
      if (current?.is_partner_books) params.force_partner_books = true;
      const r = await api.delete(`/companies/${currentId}`, { params });
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

      {/* --- Tabbed navigation --- */}
      <div
        className="flex flex-wrap gap-1 border-b border-slate-200"
        data-testid="settings-tabs"
      >
        {[
          ["bookkeeping",   "Bookkeeping"],
          ["profile",       "Profile"],
          ["advanced",      "Advanced Features"],
          ["report_style",  "Report Styling"],
          ["tours",         "Tours & Tips"],
          ["quickbooks",    "QuickBooks"],
          ["danger",        "Danger Zone"],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => goTab(k)}
            data-testid={`settings-tab-${k}`}
            className={`px-4 py-2 -mb-px text-sm font-medium border-b-2 transition-colors ${
              tab === k
                ? (k === "danger"
                    ? "border-red-600 text-red-700"
                    : "border-slate-900 text-slate-900")
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* --- Bookkeeping mode + industry template (AI-First Beta) --- */}
      {tab === "bookkeeping" && (
      <div className="rounded-xl border bg-white p-5 space-y-4" data-testid="ai-first-settings-card">
        <h3 className="font-heading font-semibold text-lg">Bookkeeping</h3>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Industry template
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Seeds a curated Chart of Accounts for this industry. Non-destructive —
            only ADDS missing accounts.
          </p>
          <IndustryTemplatePicker
            companyId={currentId}
            value={current?.industry_template}
            onChange={() => refresh?.()}
          />
        </div>
        <div className="border-t pt-4">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Categorization mode
          </div>
          <CategorizationModeToggle
            companyId={currentId}
            initialMode={current?.categorization_mode || "standard"}
          />
        </div>
      </div>
      )}

      {/* --- Profile card --- */}
      {tab === "profile" && (
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
      )}

      {/* --- Advanced Features (Feb 2026 Phase 2) — Classes,
           Projects, Budgets. Each flag is independent so a company
           can enable Budgets without Projects, etc. --- */}
      {tab === "advanced" && (
        <AdvancedFeaturesCard
          companyId={currentId}
          features={current?.features}
          onChanged={() => refresh?.()}
        />
      )}

      {/* --- Report styling --- */}
      {tab === "report_style" && (
      <ReportStylingCard
        value={form.report_style}
        onChange={(next) => setForm((f) => ({ ...f, report_style: next }))}
        onSave={save}
        saving={saving}
      />
      )}

      {/* --- Tours & tips --- */}
      {tab === "tours" && (
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
      )}

      {/* --- QuickBooks environment (sandbox / production) — sits
           immediately above Danger Zone per Feb 2026 rollout. --- */}
      {tab === "quickbooks" && (
        <QboEnvToggle companyId={currentId} />
      )}

      {/* --- Danger zone --- */}
      {tab === "danger" && (
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
              <AlertDialogTitle>
                Delete &quot;{current?.name}&quot;?
                {current?.is_firm_books && (
                  <span
                    className="ml-2 inline-block px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-800 text-[10px] font-semibold uppercase tracking-widest align-middle"
                    title="This is your firm's protected accounting entity"
                  >
                    Firm Books
                  </span>
                )}
              </AlertDialogTitle>
              <AlertDialogDescription>
                This action is <span className="font-semibold text-red-700">permanent</span>.
                {current?.is_firm_books && (
                  <span className="block mt-2 text-red-700 font-medium">
                    ⚠ This is your Firm Books company — the accounting
                    entity for your own firm. Deleting it removes every
                    transaction, JE, and audit trail for your own books.
                    A new Firm Books will be auto-provisioned on your
                    next login unless you PATCH your role first.
                  </span>
                )}
                <span className="block mt-2">
                  To confirm, type the company name below exactly as shown:
                </span>
                <div className="mt-2 mb-1 flex items-center gap-2">
                  <span className="font-mono-num text-slate-900">{current?.name}</span>
                  <button
                    type="button"
                    data-testid="settings-delete-copy-name"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(current?.name || "");
                        toast.success("Company name copied — paste into the box below");
                      } catch {
                        // Older browsers / iframe restrictions —
                        // fall back to pre-filling the input for the
                        // user so they aren't stuck.
                        setConfirmName(current?.name || "");
                        toast.info("Pre-filled the confirm box for you");
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                    title="Copy the exact name to your clipboard"
                  >
                    <Copy size={11} /> Copy
                  </button>
                </div>
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
                disabled={deleting || normName(confirmName) !== normName(current?.name)}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? (<><Loader2 size={14} className="animate-spin mr-2" />Deleting…</>) : "Permanently delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      )}
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

// Defaults mirrored from `backend/reports.py::DEFAULT_REPORT_STYLE` +
// `DEFAULT_REPORT_LABELS`. Keeping them here means the settings UI can
// pre-fill placeholder text and preview the un-customized state before
// the first save.
const RS_DEFAULTS = {
  font_family:          "Helvetica",
  title_font_size:      18,
  title_color:          "#0F172A",
  title_space_after:    10,
  subtitle_font_size:   11,
  subtitle_color:       "#52525B",
  subtitle_space_after: 3,
  section_font_size:    11,
  section_color:        "#0F172A",
  section_bg_color:     "#F1F5F9",
};

const RS_REPORT_LABELS = [
  ["income-statement",  "Income Statement"],
  ["balance-sheet",     "Balance Sheet"],
  ["trial-balance",     "Trial Balance"],
  ["general-ledger",    "General Ledger"],
  ["cash-flow",         "Statement of Cash Flows"],
  ["sales-tax",         "Sales Tax Liability"],
  ["1099-summary",      "1099 Summary"],
  ["account-detail",    "Account Detail"],
];

function ReportStylingCard({ value, onChange, onSave, saving }) {
  const rs = value || {};
  const labels = rs.labels || {};
  const update = (patch) => onChange({ ...(value || {}), ...patch });
  const updateLabel = (slug, val) => {
    const nextLabels = { ...(labels || {}) };
    if (val && val.trim()) nextLabels[slug] = val;
    else delete nextLabels[slug];
    onChange({ ...(value || {}), labels: nextLabels });
  };
  const resetAll = () => onChange(null);

  return (
    <div
      className="rounded-xl border bg-white p-5 space-y-4"
      data-testid="settings-report-style-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-heading font-semibold text-lg">Report styling</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            Customize how every financial report renders — on-screen and
            in exported PDFs. Change the report names your clients see,
            pick a font family, tune header colors and spacing. Empty
            fields fall back to sensible defaults.
          </p>
        </div>
        <button
          type="button"
          data-testid="settings-report-style-reset"
          onClick={resetAll}
          className="text-xs text-slate-500 hover:text-rose-600 underline shrink-0"
          title="Restore every knob to the app defaults"
        >
          Reset to defaults
        </button>
      </div>

      {/* Fonts + sizes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Font family">
          <select
            data-testid="rs-font-family"
            value={rs.font_family || RS_DEFAULTS.font_family}
            onChange={(e) => update({ font_family: e.target.value })}
            className="w-full border rounded-md px-3 py-2 text-sm bg-white"
          >
            <optgroup label="Built-in">
              <option value="Helvetica">Helvetica (sans-serif)</option>
              <option value="Times-Roman">Times Roman (serif)</option>
              <option value="Courier">Courier (mono)</option>
            </optgroup>
            <optgroup label="Sans-serif">
              <option value="Inter">Inter</option>
              <option value="Roboto">Roboto</option>
              <option value="OpenSans">Open Sans</option>
              <option value="Lato">Lato</option>
              <option value="Poppins">Poppins</option>
              <option value="Nunito">Nunito</option>
            </optgroup>
            <optgroup label="Serif">
              <option value="PTSerif">PT Serif</option>
              <option value="PlayfairDisplay">Playfair Display</option>
              <option value="Lora">Lora</option>
              <option value="LibreBaskerville">Libre Baskerville</option>
            </optgroup>
            <optgroup label="Monospace">
              <option value="JetBrainsMono">JetBrains Mono</option>
              <option value="IBMPlexMono">IBM Plex Mono</option>
            </optgroup>
          </select>
        </Field>
        <Field label="Title size (pt)">
          <input
            type="number" min={8} max={48}
            data-testid="rs-title-size"
            value={rs.title_font_size ?? RS_DEFAULTS.title_font_size}
            onChange={(e) => update({ title_font_size: Number(e.target.value) || RS_DEFAULTS.title_font_size })}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Subtitle size (pt)">
          <input
            type="number" min={6} max={24}
            data-testid="rs-subtitle-size"
            value={rs.subtitle_font_size ?? RS_DEFAULTS.subtitle_font_size}
            onChange={(e) => update({ subtitle_font_size: Number(e.target.value) || RS_DEFAULTS.subtitle_font_size })}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
        </Field>
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ColorField label="Title color"    value={rs.title_color    ?? RS_DEFAULTS.title_color}
                    onChange={(v) => update({ title_color: v })} testId="rs-title-color" />
        <ColorField label="Subtitle color" value={rs.subtitle_color ?? RS_DEFAULTS.subtitle_color}
                    onChange={(v) => update({ subtitle_color: v })} testId="rs-subtitle-color" />
        <ColorField label="Section color"  value={rs.section_color  ?? RS_DEFAULTS.section_color}
                    onChange={(v) => update({ section_color: v })} testId="rs-section-color" />
        <ColorField label="Section background" value={rs.section_bg_color ?? RS_DEFAULTS.section_bg_color}
                    onChange={(v) => update({ section_bg_color: v })} testId="rs-section-bg-color" />
      </div>

      {/* Header spacing */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Space after title (pt)">
          <input
            type="number" min={0} max={40}
            data-testid="rs-title-space"
            value={rs.title_space_after ?? RS_DEFAULTS.title_space_after}
            onChange={(e) => update({ title_space_after: Number(e.target.value) || 0 })}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Space after subtitle (pt)">
          <input
            type="number" min={0} max={40}
            data-testid="rs-subtitle-space"
            value={rs.subtitle_space_after ?? RS_DEFAULTS.subtitle_space_after}
            onChange={(e) => update({ subtitle_space_after: Number(e.target.value) || 0 })}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
        </Field>
      </div>

      {/* Per-report label overrides */}
      <div className="border-t pt-4">
        <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">
          Report names
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Rename any report so it matches how your firm labels it — e.g.
          "Income Statement" → "Profit &amp; Loss". Leave a field blank
          to use the built-in name.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {RS_REPORT_LABELS.map(([slug, deflabel]) => (
            <Field key={slug} label={deflabel}>
              <input
                type="text"
                data-testid={`rs-label-${slug}`}
                value={labels[slug] || ""}
                onChange={(e) => updateLabel(slug, e.target.value)}
                placeholder={deflabel}
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
            </Field>
          ))}
        </div>
      </div>

      <div className="pt-2 flex items-center gap-2">
        <button
          data-testid="settings-report-style-save"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm rounded-md hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save report styling"}
        </button>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange, testId }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1 font-semibold">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 rounded border border-slate-300 bg-white cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 border rounded-md px-2 py-2 text-xs font-mono"
        />
      </div>
    </label>
  );
}


// ---------------------------------------------------------------------
// Advanced Features toggle card (Phase 2 — Feb 2026)
// ---------------------------------------------------------------------
// Three independent booleans on `companies.features`. Turning any flag
// ON is free and non-destructive; turning OFF hides the UI but never
// deletes data. Each toggle explains the tradeoff so the Pro can pick
// with confidence — no marketing pitch, just what changes.
function AdvancedFeaturesCard({ companyId, features, onChanged }) {
  const fx = features || {};
  const [busy, setBusy] = React.useState({}); // flag → true

  const flip = async (flag, next) => {
    setBusy(b => ({ ...b, [flag]: true }));
    try {
      await api.patch(`/companies/${companyId}/features`, { [flag]: next });
      toast.success(next ? "Enabled" : "Disabled");
      onChanged?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setBusy(b => ({ ...b, [flag]: false }));
    }
  };

  const rows = [
    {
      key: "classes_enabled",
      label: "Classes",
      status: "Available",
      blurb:
        "Tag every transaction with a permanent business segment (department, product line, location). Slice your P&L along that axis. Best when segments outlive individual jobs.",
    },
    {
      key: "projects_enabled",
      label: "Projects",
      status: "Coming soon",
      blurb:
        "Track profitability for time-bound customer jobs — income, expenses, labor rolled up per project, with an Estimates vs Actuals report.",
      disabled: true,
    },
    {
      key: "budgets_enabled",
      label: "Budgets",
      status: "Coming soon",
      blurb:
        "Set monthly budget targets per account (or per class/project) and track Budget vs Actuals as the month progresses.",
      disabled: true,
    },
  ];

  return (
    <div className="rounded-xl border bg-white p-5 space-y-4" data-testid="settings-advanced-card">
      <div>
        <div className="text-sm font-semibold text-slate-900">Advanced features</div>
        <div className="text-xs text-slate-500">
          Turn on what your business actually needs. Each toggle is independent and safe to flip back off — nothing is deleted.
        </div>
      </div>
      <ul className="divide-y divide-slate-100 -mx-5">
        {rows.map(r => {
          const on = !!fx[r.key];
          return (
            <li key={r.key} className="px-5 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">{r.label}</span>
                  <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${
                    r.status === "Available"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}>{r.status}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{r.blurb}</div>
              </div>
              <button
                type="button"
                onClick={() => flip(r.key, !on)}
                disabled={busy[r.key] || r.disabled}
                data-testid={`toggle-${r.key}`}
                aria-pressed={on}
                className={`shrink-0 relative w-11 h-6 rounded-full transition-colors ${
                  on ? "bg-cyan-600" : "bg-slate-300"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title={r.disabled ? "Not yet available" : on ? "Click to disable" : "Click to enable"}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  on ? "translate-x-5" : ""
                }`} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

