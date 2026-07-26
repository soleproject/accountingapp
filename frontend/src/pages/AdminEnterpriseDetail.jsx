// -----------------------------------------------------------------------
// AdminEnterpriseDetail — Superadmin-only page.
// URL: /admin/enterprises/:eid
//
// Shows one enterprise (accounting-firm parent) with:
//   • KPI row  — Pros, Clients, Companies, Free spots (used/allotted, remaining)
//   • Free-allotment inline editor (superadmin only)
//   • Pros list — every Pro user belonging to the enterprise
//   • Companies list report — every company any of those Pros manages,
//     with owner (client), managing Pro, billing product/payer/state
// -----------------------------------------------------------------------
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import {
  ArrowLeft, Loader2, Save, Shield, Users2, Building2, Ticket, Gift, Pencil,
  Sparkles, CheckCircle2, Clock, X, Receipt, Play, ChevronRight, ChevronDown,
} from "lucide-react";

const PRODUCT_LABELS = {
  simple_start: "Simple Start",
  essentials: "Essentials",
  plus: "Plus",
  advanced: "Advanced",
};

const PAYER_LABELS = {
  client_email: "Client (email bill)",
  client_card: "Client card",
  enterprise: "Enterprise pays",
  free_spot: "Free spot",
};

const BILLING_STATE_STYLES = {
  active:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending:   "bg-amber-50   text-amber-700   border-amber-200",
  past_due:  "bg-rose-50    text-rose-700    border-rose-200",
  canceled:  "bg-slate-100  text-slate-600   border-slate-300",
  free_spot: "bg-violet-50  text-violet-700  border-violet-200",
};


export default function AdminEnterpriseDetail() {
  const { eid } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [allotDraft, setAllotDraft] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/enterprises/${eid}`);
      setData(r.data);
      setNameDraft(r.data.enterprise.name || "");
      setAllotDraft(r.data.enterprise.free_user_allotment ?? 0);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load enterprise");
    } finally { setLoading(false); }
  };
  useEffect(() => { if (eid) load(); /* eslint-disable-next-line */ }, [eid]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/enterprises/${eid}`, {
        name: nameDraft,
        free_user_allotment: Number(allotDraft) || 0,
      });
      toast.success("Enterprise updated");
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  if (user?.role !== "superadmin") {
    return (
      <div className="p-8 text-sm text-slate-500">
        Only superadmins can view enterprises.
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" /> Loading enterprise…
      </div>
    );
  }

  const ent = data.enterprise;

  return (
    <div className="space-y-5" data-testid="admin-enterprise-detail">
      {/* ---------- Header ---------- */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => nav(-1)}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"
            title="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
                <Shield size={15} />
              </span>
              {editing ? (
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="border rounded-md px-2 py-1 text-2xl font-heading font-bold"
                  maxLength={80}
                  data-testid="ent-name-input"
                />
              ) : (
                <h1 className="font-heading text-3xl font-bold tracking-tight truncate">
                  {ent.name}
                </h1>
              )}
              {ent.is_default && (
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600 font-medium">
                  Default
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              slug: <span className="font-mono-num">{ent.slug}</span>
              {" · "}
              default product: <span className="font-mono-num">{PRODUCT_LABELS[ent.default_product] || ent.default_product}</span>
              {ent.default_discount ? " · discount" : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                onClick={() => { setEditing(false); setNameDraft(ent.name); setAllotDraft(ent.free_user_allotment); }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
              ><X size={13} /> Cancel</button>
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
                data-testid="ent-save-btn"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
              data-testid="ent-edit-btn"
            >
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
      </div>

      {/* ---------- KPIs ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="ent-kpi-row">
        <KpiCard icon={<Users2 size={13} />} label="Pros"      value={ent.pros_count}      tone="indigo" />
        <KpiCard icon={<Ticket size={13} />} label="Clients"   value={ent.clients_count}   tone="cyan" />
        <KpiCard icon={<Building2 size={13} />} label="Companies" value={ent.companies_count} tone="violet" />
        <KpiCard
          icon={<Gift size={13} />}
          label="Free spots (used / max)"
          value={
            <span className="flex items-baseline gap-1.5">
              <span>{ent.free_used}</span>
              <span className="text-slate-400">/</span>
              {editing ? (
                <input
                  type="number" min={0} max={10000} value={allotDraft}
                  onChange={(e) => setAllotDraft(e.target.value)}
                  className="w-16 border rounded-md px-1 py-0.5 text-xl font-mono-num"
                  data-testid="ent-allotment-input"
                />
              ) : (
                <span>{ent.free_user_allotment}</span>
              )}
              <span className="text-xs text-slate-500 ml-1 font-normal">
                ({ent.free_remaining} left)
              </span>
            </span>
          }
          tone="emerald"
        />
      </div>
      {ent.free_user_allotment === 0 && !editing && (
        <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">
          <b>Allotment is 0.</b> Every client under this enterprise must pay for their subscription.
          Click <b>Edit</b> above and raise the free-spot number to comp specific clients.
        </div>
      )}

      {/* ---------- Pros ---------- */}
      <section className="rounded-xl border bg-white overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50/60 flex items-center gap-2">
          <Users2 size={14} className="text-slate-500" />
          <h2 className="font-heading font-semibold text-sm">
            Pros ({data.pros.length})
          </h2>
        </div>
        {!data.pros.length ? (
          <div className="p-6 text-sm text-slate-500">No Pros belong to this enterprise yet.</div>
        ) : (
          <ul className="divide-y">
            {data.pros.map((p) => (
              <li key={p.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name || p.email}</div>
                  <div className="text-xs text-slate-500 truncate">{p.email}</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {p.firm_name && (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {p.firm_name}
                    </span>
                  )}
                  <span className="text-[11px] text-slate-400">
                    Joined {p.joined_at ? new Date(p.joined_at).toLocaleDateString() : "—"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- Companies list report ---------- */}
      <section className="rounded-xl border bg-white overflow-hidden" data-testid="ent-companies-table">
        <div className="px-5 py-3 border-b bg-slate-50/60 flex items-center gap-2">
          <Building2 size={14} className="text-slate-500" />
          <h2 className="font-heading font-semibold text-sm">
            Companies ({data.companies.length})
          </h2>
        </div>
        {!data.companies.length ? (
          <div className="p-6 text-sm text-slate-500">No companies under this enterprise yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/40 text-xs text-slate-500">
                <tr>
                  <th className="text-left px-5 py-2 font-medium">Company</th>
                  <th className="text-left px-3 py-2 font-medium">Owner (client)</th>
                  <th className="text-left px-3 py-2 font-medium">Managing Pro</th>
                  <th className="text-left px-3 py-2 font-medium">Product</th>
                  <th className="text-left px-3 py-2 font-medium">Payer</th>
                  <th className="text-left px-3 py-2 font-medium">Billing</th>
                  <th className="text-left px-3 py-2 font-medium">Onboarding</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-slate-50/40" data-testid={`ent-company-row-${c.id}`}>
                    <td className="px-5 py-2.5">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[11px] text-slate-500">{c.business_type || "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div>{c.owner_name || "—"}</div>
                      <div className="text-[11px] text-slate-500">{c.owner_email || "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div>{c.pro_name || "—"}</div>
                      <div className="text-[11px] text-slate-500">{c.pro_email || "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.billing_product ? (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200">
                          {PRODUCT_LABELS[c.billing_product] || c.billing_product}
                          {c.billing_discount ? " · disc" : ""}
                        </span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.billing_payer ? (
                        <span className="text-[11px] text-slate-700">
                          {PAYER_LABELS[c.billing_payer] || c.billing_payer}
                        </span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded border ${BILLING_STATE_STYLES[c.billing_state] || BILLING_STATE_STYLES.pending}`}
                      >
                        {c.billing_state || "pending"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.onboarding_complete
                        ? <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px]"><CheckCircle2 size={11} /> ready</span>
                        : <span className="inline-flex items-center gap-1 text-amber-700 text-[11px]"><Clock size={11} /> onboarding</span>}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-slate-500">
                      {c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Consolidated billing (Phase D) ---------- */}
      <EnterpriseBillingSection eid={eid} />
    </div>
  );
}


// --------------------------------------------------------------------------
// EnterpriseBillingSection — monthly consolidated invoicing panel.
//   • Lists past `enterprise_invoices` (status, month, amount, PDF link)
//   • "Preview next invoice" runs a dry-run for the prior month
//   • "Bill now" actually creates the Stripe invoice (real in prod,
//     no-ops with a clear "not configured" toast in preview).
// --------------------------------------------------------------------------
function EnterpriseBillingSection({ eid }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openLines, setOpenLines] = useState({});
  const toggleLines = (id) => setOpenLines((s) => ({ ...s, [id]: !s[id] }));

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/enterprises/${eid}/invoices`);
      setInvoices(r.data?.invoices || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load invoices");
    } finally { setLoading(false); }
  };
  useEffect(() => { if (eid) load(); /* eslint-disable-next-line */ }, [eid]);

  const runPreview = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/admin/enterprises/${eid}/bill-now`, { dry_run: true });
      setPreview(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Preview failed");
    } finally { setBusy(false); }
  };

  const runBillNow = async () => {
    if (!window.confirm("Create a real Stripe invoice for the prior month? This will charge the enterprise's Stripe customer.")) return;
    setBusy(true);
    try {
      const r = await api.post(`/admin/enterprises/${eid}/bill-now`, { dry_run: false });
      const s = r.data?.status;
      if (s === "finalized") toast.success(`Invoice finalized · $${((r.data.amount_due_cents || 0) / 100).toFixed(2)}`);
      else if (s === "already_billed") toast.success("Already billed for this month.");
      else if (s === "empty") toast("No enterprise-paid companies to bill this month.");
      else if (s === "dry_run") toast(`Preview only — Stripe not configured. ${r.data.payable_count} payable / ${r.data.skipped_count} skipped.`);
      else toast.error(`Status: ${s}${r.data?.error ? ` — ${r.data.error}` : ""}`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Bill-now failed");
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border bg-white overflow-hidden" data-testid="ent-billing-section">
      <div className="px-5 py-3 border-b bg-slate-50/60 flex items-center gap-2 flex-wrap">
        <Receipt size={14} className="text-slate-500" />
        <h2 className="font-heading font-semibold text-sm">Consolidated billing</h2>
        <span className="text-[10px] text-slate-500">
          5th-of-month scheduled · all <code className="bg-slate-100 px-1 rounded">Enterprise pays</code> companies rolled into one Stripe invoice
        </span>
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={runPreview}
            disabled={busy}
            data-testid="ent-billing-preview-btn"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Preview
          </button>
          <button
            onClick={runBillNow}
            disabled={busy}
            data-testid="ent-billing-billnow-btn"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Bill now
          </button>
        </div>
      </div>

      {/* Dry-run preview panel */}
      {preview && (
        <div className="border-b bg-cyan-50/40 px-5 py-3 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={12} className="text-cyan-700" />
            <b className="text-cyan-800">Preview · {preview.month_key}</b>
            <span className="text-slate-500 ml-auto">
              {preview.payable_count} payable · {preview.skipped_count} skipped
              {preview.stripe_configured ? "" : " · dry-run (Stripe not configured)"}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            {(preview.lines || []).map((ln) => (
              <div
                key={ln.company_id}
                className={`px-2 py-1 rounded border text-[11px] ${
                  ln.skipped
                    ? "bg-white border-amber-200 text-amber-800"
                    : "bg-white border-emerald-200 text-emerald-800"
                }`}
              >
                <div className="font-medium truncate">
                  {ln.skipped ? "⨯" : "✓"} {ln.company_name}
                  <span className="text-slate-400 font-normal">
                    {" "}· {ln.product}{ln.discount ? " · disc" : ""}
                  </span>
                </div>
                {ln.skipped && <div className="text-[10px] mt-0.5 opacity-80">{ln.skip_reason}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="p-5 text-sm text-slate-500 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading invoices…
        </div>
      ) : !invoices.length ? (
        <div className="p-5 text-sm text-slate-500">
          No consolidated invoices yet. First one runs on the 5th of the month
          for any <code className="bg-slate-100 px-1 rounded">Enterprise pays</code> companies.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/40 text-xs text-slate-500">
              <tr>
                <th className="w-6 px-2 py-2"></th>
                <th className="text-left px-3 py-2 font-medium">Month</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Lines</th>
                <th className="text-left px-3 py-2 font-medium">Amount</th>
                <th className="text-left px-3 py-2 font-medium">Stripe invoice</th>
                <th className="text-left px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const open = !!openLines[inv.id];
                const hasLines = Array.isArray(inv.lines) && inv.lines.length > 0;
                return (
                  <>
                  <tr
                    key={inv.id}
                    onClick={() => hasLines && toggleLines(inv.id)}
                    className={`border-t hover:bg-slate-50/40 ${hasLines ? "cursor-pointer" : ""}`}
                    data-testid={`ent-invoice-row-${inv.id}`}
                    title={hasLines ? "Click to reveal per-company detail" : ""}
                  >
                    <td className="px-2 py-2.5 text-slate-400">
                      {hasLines && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                    </td>
                    <td className="px-3 py-2.5 font-mono-num">{inv.month_key}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] px-2 py-0.5 rounded border ${
                        inv.status === "paid"        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : inv.status === "finalized" ? "bg-amber-50 text-amber-700 border-amber-200"
                        : inv.status === "past_due"  ? "bg-rose-50 text-rose-700 border-rose-200"
                        : inv.status === "empty"     ? "bg-slate-50 text-slate-500 border-slate-200"
                        : inv.status === "failed"    ? "bg-rose-50 text-rose-700 border-rose-200"
                        :                              "bg-slate-50 text-slate-500 border-slate-200"
                      }`}>
                        {inv.status}
                      </span>
                      {inv.error && <div className="text-[10px] text-rose-600 mt-0.5">{inv.error}</div>}
                    </td>
                    <td className="px-3 py-2.5 font-mono-num">{inv.line_count ?? (inv.lines?.length || 0)}</td>
                    <td className="px-3 py-2.5 font-mono-num">
                      {inv.amount_due_cents != null
                        ? `$${(inv.amount_due_cents / 100).toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
                      {inv.hosted_invoice_url ? (
                        <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-cyan-700 hover:underline">Open →</a>
                      ) : inv.stripe_invoice_id ? (
                        <span className="font-mono-num text-slate-500">{inv.stripe_invoice_id}</span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-slate-500">
                      {inv.created_at ? new Date(inv.created_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                  {open && hasLines && (
                    <tr key={inv.id + "_lines"} className="bg-slate-50/60 border-t border-slate-200">
                      <td></td>
                      <td colSpan={6} className="px-3 py-2.5">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
                          Why is this being billed? — per-company breakdown
                        </div>
                        <table className="w-full text-[11px]">
                          <thead className="text-[9px] uppercase text-slate-400">
                            <tr>
                              <th className="text-left pb-1 pr-3 font-medium">Company</th>
                              <th className="text-left pb-1 pr-3 font-medium">Product</th>
                              <th className="text-left pb-1 pr-3 font-medium">Price ID / reason</th>
                              <th className="text-left pb-1 pr-3 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {inv.lines.map((ln, i) => (
                              <tr key={ln.company_id || i} className="border-t border-slate-100">
                                <td className="py-1 pr-3 font-medium text-slate-700">
                                  {ln.company_name || "—"}
                                  <div className="text-[9px] text-slate-400 font-mono-num">{(ln.company_id || "").slice(0, 8)}</div>
                                </td>
                                <td className="py-1 pr-3">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200">
                                    {ln.product}{ln.discount ? " · disc" : ""}
                                  </span>
                                </td>
                                <td className="py-1 pr-3">
                                  {ln.skipped ? (
                                    <span className="text-amber-700">{ln.skip_reason}</span>
                                  ) : (
                                    <span className="font-mono-num text-slate-600">{ln.price_id}</span>
                                  )}
                                </td>
                                <td className="py-1 pr-3">
                                  {ln.skipped ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">skipped</span>
                                  ) : (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">billed</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}



function KpiCard({ icon, label, value, tone = "slate" }) {
  const tones = {
    slate:   "bg-slate-50   text-slate-700   border-slate-200",
    indigo:  "bg-indigo-50  text-indigo-700  border-indigo-200",
    cyan:    "bg-cyan-50    text-cyan-700    border-cyan-200",
    violet:  "bg-violet-50  text-violet-700  border-violet-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <div className="text-[10px] uppercase tracking-wide flex items-center gap-1 opacity-80">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-mono-num font-semibold">{value}</div>
    </div>
  );
}
