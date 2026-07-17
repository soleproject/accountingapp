import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import {
  AlertTriangle, CheckCircle2, ArrowRight, Plus, X, Loader2, UserPlus,
  BellRing, Wand2, FileWarning, ReceiptText, ScrollText, Sparkles,
} from "lucide-react";
import { toast } from "sonner";

export default function ProClients() {
  const [clients, setClients] = useState([]);
  const [firm, setFirm] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showOnlyAction, setShowOnlyAction] = useState(false);
  const { switchCompany, refresh } = useCompany();

  const load = async () => {
    const [c, a] = await Promise.all([
      api.get("/pro/clients"),
      api.get("/pro/firm-attention"),
    ]);
    // Merge per-client attention counts into the client cards (keyed by id).
    const byId = Object.fromEntries((a.data.clients || []).map(x => [x.id, x]));
    setClients((c.data.clients || []).map(cl => ({ ...cl, ...(byId[cl.id] || {}) })));
    setFirm(a.data);
  };
  useEffect(() => { load(); }, []);

  const visible = showOnlyAction
    ? clients.filter(c => (c.action_count || 0) > 0)
    : clients;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">My Clients</h1>
          <p className="text-slate-500 text-sm mt-1">Firm portfolio · onboarding status · transactions needing your call.</p>
        </div>
        <button
          data-testid="new-client-btn"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-slate-900 text-white text-sm"
        >
          <UserPlus size={14} /> New Client
        </button>
      </div>

      <FirmAttentionTile
        firm={firm}
        showOnlyAction={showOnlyAction}
        onToggle={() => setShowOnlyAction(v => !v)}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(c => {
          const act = c.action_count || 0;
          return (
            <div
              key={c.id}
              className={`rounded-xl border bg-white p-4 hover:border-slate-400 transition ${
                act > 0 ? "border-amber-300" : ""
              }`}
              data-testid={`client-card-${c.id}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-heading font-semibold text-lg">{c.name}</div>
                  <div className="text-xs text-slate-500">{c.business_type || "—"}</div>
                </div>
                <div className="flex items-center gap-1">
                  {act > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 flex items-center gap-1"
                      title="Needs your attention"
                    >
                      <BellRing size={10} /> {act}
                    </span>
                  )}
                  {c.onboarding_complete
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 flex items-center gap-1"><CheckCircle2 size={10} /> Ready</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Onboarding</span>}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-md bg-slate-50 p-2">
                  <div className="text-[10px] uppercase text-slate-500">Transactions</div>
                  <div className="font-mono-num font-semibold">{c.transactions}</div>
                </div>
                <div className="rounded-md bg-orange-50 p-2">
                  <div className="text-[10px] uppercase text-orange-700 flex items-center gap-1"><AlertTriangle size={10} /> Review</div>
                  <div className="font-mono-num font-semibold text-orange-700">{c.needs_review ?? c.flagged_count ?? 0}</div>
                </div>
              </div>
              {act > 0 && (
                <ClientActionSummary c={c} />
              )}
              <button
                onClick={() => { switchCompany(c.id); window.location.href = "/dashboard"; }}
                className="mt-3 w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
                data-testid={`open-books-${c.id}`}
              >
                Open books <ArrowRight size={12} />
              </button>
            </div>
          );
        })}
        {!visible.length && (
          <div className="col-span-full text-sm text-slate-500 border border-dashed rounded-xl p-8 text-center">
            {showOnlyAction
              ? "All clients are clear. Nothing needs your attention today."
              : "No clients yet. Click \"New Client\" to add your first one."}
          </div>
        )}
      </div>

      {creating && <NewClientModal onClose={() => setCreating(false)} onCreated={async () => { await load(); await refresh(); setCreating(false); }} />}
    </div>
  );
}

function FirmAttentionTile({ firm, showOnlyAction, onToggle }) {
  if (!firm) return null;
  const { clients_total = 0, clients_needing_action = 0, totals = {} } = firm;
  const grandTotal =
    (totals.flagged || 0) + (totals.suggested_rules || 0)
    + (totals.overdue_invoices || 0) + (totals.overdue_bills || 0)
    + (totals.unreconciled || 0);

  if (clients_total === 0) return null;

  if (grandTotal === 0) {
    return (
      <div
        className="rounded-xl border bg-emerald-50/60 border-emerald-200 p-4 flex items-center gap-3"
        data-testid="firm-tile-empty"
      >
        <CheckCircle2 size={18} className="text-emerald-600" />
        <div className="text-sm text-emerald-900">
          <b>All {clients_total} client{clients_total === 1 ? "" : "s"} are clear.</b>{" "}
          Nothing needs your attention this morning.
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border bg-gradient-to-r from-amber-50 to-white overflow-hidden"
      data-testid="firm-attention-tile"
    >
      <div className="px-5 py-3 border-b border-amber-100 flex flex-wrap items-center gap-3">
        <BellRing size={18} className="text-amber-700 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="font-heading font-semibold">
            <span className="text-amber-800">{clients_needing_action}</span>
            <span className="text-slate-700"> of {clients_total} client{clients_total === 1 ? "" : "s"} need action today</span>
          </h2>
          <div className="text-xs text-slate-600 mt-0.5">
            {grandTotal} item{grandTotal === 1 ? "" : "s"} across all books
          </div>
        </div>
        <button
          onClick={onToggle}
          data-testid="firm-toggle-filter"
          className={`text-xs px-3 py-1.5 rounded-md border ${
            showOnlyAction
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
          }`}
        >
          {showOnlyAction ? "Showing action only" : "Filter to action needed"}
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x">
        <FirmStat label="Flagged" value={totals.flagged} icon={AlertTriangle} tone="amber" />
        <FirmStat label="Suggested rules" value={totals.suggested_rules} icon={Wand2} tone="indigo" />
        <FirmStat label="Overdue invoices" value={totals.overdue_invoices} icon={FileWarning} tone="rose" />
        <FirmStat label="Overdue bills" value={totals.overdue_bills} icon={ReceiptText} tone="rose" />
        <FirmStat label="Unreconciled" value={totals.unreconciled} icon={ScrollText} tone="rose" />
      </div>
    </div>
  );
}

const FIRM_TONE = {
  amber:  { fg: "text-amber-700",  ring: "bg-amber-100" },
  indigo: { fg: "text-indigo-700", ring: "bg-indigo-100" },
  rose:   { fg: "text-rose-700",   ring: "bg-rose-100" },
};

function FirmStat({ label, value = 0, icon: Icon, tone }) {
  const t = FIRM_TONE[tone] || FIRM_TONE.amber;
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${t.ring}`}>
        <Icon size={14} className={t.fg} />
      </div>
      <div className="min-w-0">
        <div className={`text-xl font-bold tabular-nums ${value > 0 ? "text-slate-900" : "text-slate-400"}`}>
          {value}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 truncate">{label}</div>
      </div>
    </div>
  );
}

function ClientActionSummary({ c }) {
  const chips = [];
  if (c.flagged_count) chips.push({ label: "flag", n: c.flagged_count, cls: "bg-amber-50 text-amber-800" });
  if (c.suggested_rules_count) chips.push({ label: "rules", n: c.suggested_rules_count, cls: "bg-indigo-50 text-indigo-800" });
  if (c.overdue_invoices_count) chips.push({ label: "inv", n: c.overdue_invoices_count, cls: "bg-rose-50 text-rose-800" });
  if (c.overdue_bills_count) chips.push({ label: "bills", n: c.overdue_bills_count, cls: "bg-rose-50 text-rose-800" });
  if (c.unreconciled_accounts_count) chips.push({ label: "recon", n: c.unreconciled_accounts_count, cls: "bg-slate-100 text-slate-700" });
  if (!chips.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {chips.map(ch => (
        <span key={ch.label} className={`text-[10px] px-1.5 py-0.5 rounded ${ch.cls}`}>
          {ch.n} {ch.label}
        </span>
      ))}
    </div>
  );
}

function NewClientModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    company_name: "", business_type: "", business_description: "",
    client_name: "", client_email: "", client_password: "",
    reporting_basis: "accrual",
  });
  const [busy, setBusy] = useState(false);
  const [existingEmail, setExistingEmail] = useState(false);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Debounced check: does this email already belong to a client?
  useEffect(() => {
    setExistingEmail(false);
    const email = (form.client_email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    const h = setTimeout(async () => {
      setCheckingEmail(true);
      try {
        const r = await api.get(`/pro/clients/lookup`, { params: { email } });
        setExistingEmail(!!r.data.exists);
        if (r.data.exists && r.data.name && !form.client_name) {
          update("client_name", r.data.name);
        }
      } catch { setExistingEmail(false); }
      finally { setCheckingEmail(false); }
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.client_email]);

  const save = async () => {
    if (!form.company_name || !form.client_name || !form.client_email) {
      toast.error("Fill company name + client name + email"); return;
    }
    if (!existingEmail && !form.client_password) {
      toast.error("Password required for new client emails"); return;
    }
    setBusy(true);
    try {
      const r = await api.post("/pro/clients", form);
      if (r.data.reused_existing_user) {
        toast.success(
          `${form.company_name} added to ${form.client_email}'s existing login. They now own ${r.data.owner_company_count} companies — switch via the top-left dropdown.`,
          { duration: 7000 },
        );
      } else {
        toast.success(`Client "${form.client_name}" added to ${form.company_name}. Onboarding is ready to start.`);
      }
      onCreated();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create client");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold">Add a new client</h3>
          <button onClick={onClose} data-testid={TID.cancelBtn} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-slate-500 border-b pb-1">Company</div>
          <div>
            <label className="text-xs text-slate-600">Company name</label>
            <input data-testid="new-client-company-name" value={form.company_name}
                   onChange={(e) => update("company_name", e.target.value)}
                   className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-600">Business type</label>
              <input value={form.business_type} onChange={(e) => update("business_type", e.target.value)}
                     placeholder="e.g. Marketing agency" className="w-full mt-1 border rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="text-xs text-slate-600">Reporting basis</label>
              <select value={form.reporting_basis} onChange={(e) => update("reporting_basis", e.target.value)}
                      className="w-full mt-1 border rounded px-2 py-1.5">
                <option value="accrual">Accrual</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600">What does the business do?</label>
            <textarea rows={2} value={form.business_description} onChange={(e) => update("business_description", e.target.value)}
                      className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>

          <div className="text-xs uppercase tracking-wider text-slate-500 border-b pb-1 pt-2">Owner login</div>
          <div>
            <label className="text-xs text-slate-600">Client name</label>
            <input data-testid="new-client-name" value={form.client_name} onChange={(e) => update("client_name", e.target.value)}
                   className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-600">Email</label>
              <input data-testid="new-client-email" type="email" value={form.client_email}
                     onChange={(e) => update("client_email", e.target.value)}
                     className={`w-full mt-1 border rounded px-2 py-1.5 ${existingEmail ? "border-cyan-400 bg-cyan-50/40" : ""}`} />
              {checkingEmail && <div className="text-[10px] text-slate-400 mt-1">Checking…</div>}
              {existingEmail && !checkingEmail && (
                <div className="text-[11px] text-cyan-700 mt-1" data-testid="new-client-email-reuse-hint">
                  ✓ Existing client login — this new company will be added to their dropdown.
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-slate-600">
                Temporary password
                {existingEmail && <span className="text-slate-400 font-normal"> (not needed — reusing)</span>}
              </label>
              <input data-testid="new-client-password" type="text"
                     value={existingEmail ? "" : form.client_password}
                     disabled={existingEmail}
                     onChange={(e) => update("client_password", e.target.value)}
                     placeholder={existingEmail ? "—" : ""}
                     className="w-full mt-1 border rounded px-2 py-1.5 font-mono-num disabled:bg-slate-100 disabled:text-slate-400" />
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            {existingEmail
              ? "This client already has a login. They'll see the new company in the top-left dropdown after their next sign-in — no invite needed."
              : "A GAAP-compliant Chart of Accounts is seeded automatically. The client can start onboarding after their first login."}
          </div>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm">Cancel</button>
          <button data-testid={TID.saveBtn} onClick={save} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm disabled:opacity-60">
            {busy && <Loader2 size={13} className="animate-spin" />} Create client
          </button>
        </div>
      </div>
    </div>
  );
}
