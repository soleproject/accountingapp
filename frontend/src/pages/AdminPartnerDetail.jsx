import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  ArrowLeft, ArrowRight, Loader2, Users as UsersIcon, Building, Building2,
  Users as Handshake, BookOpen, ExternalLink, Pencil as Edit3, Archive, Trash2, AlertTriangle,
  Shield,
} from "lucide-react";
import { WhitelabelCompToggle } from "@/pages/AdminEnterpriseDetail";
import { NewEnterpriseModal, NewClientModal } from "@/pages/ProClients";

/**
 * Superadmin — Partner Detail Page (`/admin/partners/:pid`).
 *
 * Mirrors the layout of `AdminEnterpriseDetail` — same 4-stat header,
 * same Pros section with the Comped / Revoke inline toggle (reused
 * component), and a companies list. The Pros section is where the
 * superadmin grants or revokes free white-label branding on a per-pro
 * basis under this Partner's tree.
 *
 * Route: `/admin/partners/:pid` — reachable from the "Open partner"
 * link on the Partners toggle grid in `/pro/clients`.
 */

function StatBox({ label, value, tone = "indigo", Icon }) {
  const tones = {
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-800",
    cyan: "bg-cyan-50 border-cyan-200 text-cyan-800",
    fuchsia: "bg-fuchsia-50 border-fuchsia-200 text-fuchsia-800",
    orange: "bg-orange-50 border-orange-200 text-orange-800",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider opacity-80">
        {Icon && <Icon size={12} />} {label}
      </div>
      <div className="mt-1 font-heading text-3xl font-bold">{value}</div>
    </div>
  );
}

export default function AdminPartnerDetail() {
  const { pid } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  // Danger-zone action state — busy flags and hard-delete confirmation.
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteForce, setDeleteForce] = useState(false);
  // Add-entity dialogs — surfaced from the section headers so a
  // Superadmin can provision a new enterprise / client directly
  // under this Partner. Both propagate `partner_id` to the API so
  // the welcome-email brand cascade uses the linked Partner
  // (Round 7.18, Feb 2026).
  const [creatingEnterprise, setCreatingEnterprise] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);

  async function load() {
    setErr("");
    try {
      const { data } = await api.get(`/superadmin/partners/${pid}`);
      setData(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load");
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [pid]);

  const isArchived = data?.partner?.status === "archived";

  async function toggleArchive() {
    setArchiving(true);
    try {
      const endpoint = isArchived
        ? `/superadmin/partners/${pid}/unarchive`
        : `/superadmin/partners/${pid}/archive`;
      await api.post(endpoint);
      toast.success(
        isArchived ? "Partner restored." : "Partner archived — login blocked.",
      );
      await load();
    } catch (e) {
      toast.error(
        e?.response?.data?.detail?.message ||
          e?.response?.data?.detail ||
          "Action failed",
      );
    } finally {
      setArchiving(false);
    }
  }

  async function hardDelete() {
    // Type-to-confirm — the input must match the partner's email
    // exactly (case-insensitive) before the button unlocks. Belt-
    // and-suspenders against fat-finger destruction.
    if (!data?.partner) return;
    const expected = (data.partner.email || "").toLowerCase().trim();
    if (deleteConfirm.trim().toLowerCase() !== expected) {
      toast.error("Confirmation text doesn't match the partner's email.");
      return;
    }
    setDeleting(true);
    try {
      const { data: res } = await api.delete(
        `/superadmin/partners/${pid}${deleteForce ? "?force=true" : ""}`,
      );
      const d = res.deleted || {};
      toast.success(
        `Deleted partner + ${d.enterprises || 0} enterprise(s), ` +
        `${d.companies || 0} compan${d.companies === 1 ? "y" : "ies"}, ` +
        `${d.users || 0} user(s), ${d.transactions || 0} transaction(s).`,
      );
      nav("/pro/clients?tab=partners");
    } catch (e) {
      const detail = e?.response?.data?.detail;
      if (detail?.code === "cascade_blocked_active_data") {
        // Show the counts so the operator can decide whether to force.
        toast.error(detail.message);
      } else {
        toast.error(detail?.message || detail || "Delete failed");
      }
    } finally {
      setDeleting(false);
    }
  }

  if (!data && !err) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (err) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {err}
        </div>
      </div>
    );
  }

  const p = data.partner;
  const stats = p.stats || {};
  const brandColor = p.primary_color || "#ea580c";

  return (
    <div data-testid="admin-partner-detail" className="mx-auto max-w-6xl px-4 py-6 space-y-5">
      {/* Header + back */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => nav("/pro/clients")}
          data-testid="admin-partner-back"
          className="mt-1 rounded-md border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          title="Back to Partners"
        >
          <ArrowLeft size={14} />
        </button>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold text-white"
          style={{ backgroundColor: brandColor }}
        >
          {(p.display_name || p.name || "?").charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900 truncate">
              {p.display_name || p.name}
            </h1>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200 font-medium">
              Partner
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {p.email}
            {p.subdomain && (
              <>
                {" · "}
                <span className="font-mono">{p.subdomain}.accountingapp.ai</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stat boxes */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatBox label="Pros" value={data.pros.length} tone="indigo" Icon={UsersIcon} />
        <StatBox label="Clients" value={stats.clients ?? 0} tone="cyan" Icon={UsersIcon} />
        <StatBox label="Enterprises" value={stats.enterprises ?? 0} tone="orange" Icon={Handshake} />
        <StatBox
          label="Partner Books"
          value={stats.has_partner_books ? "1" : "—"}
          tone="emerald"
          Icon={BookOpen}
        />
      </div>

      {/* Partner's own white-label — the Partner themselves is a
          Pro-like user, so they get a comp toggle too. This is what
          lets a Superadmin grant AxiomPartners (the reseller) free
          white-label without them running the Stripe checkout. */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <div className="flex items-center gap-2">
            <Handshake size={16} className="text-orange-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Partner white-label
            </h2>
          </div>
          <div className="text-xs text-slate-500">
            Grant this partner free white-label (comp) or revoke a prior comp
          </div>
        </div>
        <div className="flex items-center gap-3 p-4" data-testid="partner-self-wl-row">
          <div
            className="flex h-8 w-8 items-center justify-center rounded font-semibold text-white text-xs"
            style={{ backgroundColor: brandColor }}
          >
            {(p.display_name || p.name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">
              {p.display_name || p.name}
            </div>
            <div className="text-xs text-slate-500 truncate">{p.email}</div>
          </div>
          <WhitelabelCompToggle
            proId={p.id}
            initial={{
              // WhitelabelCompToggle reads `state.comp` / `state.paid`
              // / `state.unlocked` / `state.source` — pass all four so
              // the pill renders the correct label on refresh and the
              // Comp/Revoke button toggles the correct way.
              comp: (data.partner_wl?.source === "comp"),
              paid: (data.partner_wl?.source === "paid"),
              unlocked: !!data.partner_wl?.unlocked,
              source: data.partner_wl?.source ?? null,
            }}
          />
        </div>
      </section>

      {/* Enterprises — firm entities under this Partner (Round 7.17,
          Feb 2026). Sits directly above the Pros section so a
          Superadmin sees the firm containers before drilling into
          the individual accountants. Each row is a click-thru to the
          full enterprise detail page. */}
      <section className="rounded-xl border border-slate-200 bg-white"
                data-testid="admin-partner-enterprises">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-indigo-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Enterprises ({(data.enterprises || []).length})
            </h2>
          </div>
          <button
            data-testid="admin-partner-new-enterprise-btn"
            onClick={() => setCreatingEnterprise(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
          >
            <Shield size={12} /> New Enterprise
          </button>
        </div>
        {(!data.enterprises || data.enterprises.length === 0) ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No enterprises under this partner yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.enterprises.map(e => (
              <Link
                key={e.id}
                to={`/admin/enterprises/${e.id}`}
                data-testid={`admin-partner-enterprise-row-${e.id}`}
                className="flex items-center gap-3 p-4 hover:bg-slate-50 transition"
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded bg-indigo-100 text-indigo-700 flex-shrink-0">
                  <Shield size={13} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate flex items-center gap-2">
                    {e.name}
                    {e.is_default && (
                      <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    slug: <span className="font-mono">{e.slug}</span>
                  </div>
                </div>
                <div className="hidden sm:grid grid-cols-3 gap-4 text-xs">
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-indigo-700">Pros</div>
                    <div className="font-mono-num font-semibold text-indigo-800">{e.pros_count}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-cyan-700">Clients</div>
                    <div className="font-mono-num font-semibold text-cyan-800">{e.clients_count}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-violet-700">Cos</div>
                    <div className="font-mono-num font-semibold text-violet-800">{e.companies_count}</div>
                  </div>
                </div>
                <ArrowRight size={14} className="text-slate-400 ml-2" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Pros — Comped / Revoke column reused from AdminEnterpriseDetail */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <div className="flex items-center gap-2">
            <UsersIcon size={16} className="text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Pros ({data.pros.length})
            </h2>
          </div>
          <div className="text-xs text-slate-500">
            White-label comp column · toggle to grant/revoke free branding
          </div>
        </div>
        {data.pros.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No pros under this partner yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.pros.map((pro) => (
              <div
                key={pro.id}
                data-testid={`admin-partner-pro-row-${pro.id}`}
                className="flex items-center gap-3 p-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">
                    {pro.name}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{pro.email}</div>
                </div>
                {pro.firm_name && (
                  <span className="hidden sm:inline-flex text-xs rounded bg-indigo-50 border border-indigo-200 text-indigo-800 px-2 py-0.5">
                    {pro.firm_name}
                  </span>
                )}
                <WhitelabelCompToggle
                  proId={pro.id}
                  initial={{
                    comp: (pro.source === "comp"),
                    paid: (pro.source === "paid"),
                    unlocked: !!pro.whitelabel_unlocked,
                    source: pro.source,
                  }}
                />
                <div className="hidden md:block text-xs text-slate-400 whitespace-nowrap">
                  Joined {pro.created_at ? new Date(pro.created_at).toLocaleDateString() : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Companies */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <div className="flex items-center gap-2">
            <Building size={16} className="text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Companies ({data.companies.length})
            </h2>
          </div>
          <button
            data-testid="admin-partner-new-client-btn"
            onClick={() => setCreatingClient(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium"
          >
            <UsersIcon size={12} /> New Client
          </button>
        </div>
        {data.companies.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No client companies under this partner yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Company</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Onboarding</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.companies.map((c) => (
                  <tr key={c.id} data-testid={`admin-partner-company-row-${c.id}`}>
                    <td className="px-4 py-2 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-2 text-slate-600">{c.business_type || "—"}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${
                        c.onboarding_complete
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                      }`}>
                        {c.onboarding_complete ? "ready" : "pending"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                      {c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to={`/companies/${c.id}`}
                        className="inline-flex items-center gap-1 text-indigo-700 hover:underline text-xs"
                      >
                        Open <ExternalLink size={11} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Danger zone (Feb 2026) ---------- */}
      {/* Two destructive actions, gated behind clear visual affordance:
          1. Archive (soft) — reversible; login blocked, tree intact.
          2. Hard delete (with cascade) — irreversible; nukes the
             partner + every enterprise/company/user in their tree.
             Type-to-confirm (email) required, `force=true` needed to
             blow past the guardrail when transactions exist. */}
      <section
        data-testid="partner-danger-zone"
        className="rounded-xl border border-rose-200 bg-rose-50/40 p-5"
      >
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="h-4 w-4 text-rose-600" />
          <h2 className="font-heading font-semibold text-rose-800">Danger zone</h2>
        </div>
        <p className="text-xs text-rose-700/80 mb-4">
          Destructive actions. Archive is reversible; hard delete is not.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Archive / Unarchive */}
          <div className="rounded-md border border-amber-200 bg-white p-3">
            <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm">
              <Archive className="h-4 w-4" />
              {isArchived ? "Restore partner" : "Archive partner"}
            </div>
            <p className="text-xs text-slate-600 mt-1 mb-3">
              {isArchived
                ? "Partner is currently archived — login is blocked. Restore to re-enable access. Their tree of enterprises and clients is intact."
                : "Blocks partner login. Keeps every enterprise + client + user record so you can un-archive later. Reversible."}
            </p>
            <button
              onClick={toggleArchive}
              disabled={archiving}
              data-testid="partner-archive-btn"
              className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              {isArchived ? "Restore partner" : "Archive partner"}
            </button>
          </div>

          {/* Hard-delete */}
          <div className="rounded-md border border-rose-300 bg-white p-3">
            <div className="flex items-center gap-2 text-rose-800 font-semibold text-sm">
              <Trash2 className="h-4 w-4" />
              Delete partner (permanent)
            </div>
            <p className="text-xs text-slate-600 mt-1 mb-3">
              Nukes the partner + Partner Books + every enterprise, client
              company, and user in their tree. If any company has recorded
              transactions, you'll be prompted to confirm the force flag.
            </p>
            {!showDelete ? (
              <button
                onClick={() => setShowDelete(true)}
                data-testid="partner-delete-open-btn"
                className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-white text-sm font-medium hover:bg-rose-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete partner…
              </button>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-700">
                  Type <span className="font-mono">{p.email}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                  placeholder={p.email}
                  data-testid="partner-delete-confirm-input"
                />
                <label className="flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={deleteForce}
                    onChange={(e) => setDeleteForce(e.target.checked)}
                    data-testid="partner-delete-force-cb"
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-semibold">Force</span> — delete even
                    if client companies still have transactions. Without this,
                    the delete is blocked when active data is detected.
                  </span>
                </label>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={hardDelete}
                    disabled={
                      deleting ||
                      deleteConfirm.trim().toLowerCase() !==
                        (p.email || "").toLowerCase()
                    }
                    data-testid="partner-delete-confirm-btn"
                    className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-40"
                  >
                    {deleting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Delete forever
                  </button>
                  <button
                    onClick={() => { setShowDelete(false); setDeleteConfirm(""); setDeleteForce(false); }}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 text-sm hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Add-entity modals — dispatch `partner_id` so the resulting
          record inherits this Partner's branding cascade. */}
      {creatingEnterprise && (
        <NewEnterpriseModal
          partnerId={p.id}
          onClose={() => setCreatingEnterprise(false)}
          onCreated={async () => { setCreatingEnterprise(false); await load(); }}
        />
      )}
      {creatingClient && (
        <NewClientModal
          partnerId={p.id}
          onClose={() => setCreatingClient(false)}
          onCreated={async () => { setCreatingClient(false); await load(); }}
        />
      )}
    </div>
  );
}
