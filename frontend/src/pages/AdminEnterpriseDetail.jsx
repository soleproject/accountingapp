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
  Sparkles, CheckCircle2, Clock, X,
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
    </div>
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
