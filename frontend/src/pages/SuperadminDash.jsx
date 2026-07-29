import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import {
  Users, Building, Briefcase, Shield, ChevronRight, ChevronDown,
  Ticket, ExternalLink, ShieldPlus, X, Loader2, Copy, ShieldMinus,
  AlertTriangle, RefreshCw, Wrench, DollarSign, CheckCircle2, RotateCcw,
} from "lucide-react";
import TeamPanel from "@/components/TeamPanel";

export default function SuperadminDash() {
  const [data, setData] = useState(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [superadmins, setSuperadmins] = useState(null);
  const [ownerEmail, setOwnerEmail] = useState(null);
  useEffect(() => { api.get("/admin/overview").then(r => setData(r.data)); }, []);
  const refreshData = () => api.get("/admin/overview").then(r => setData(r.data));
  // The Grant / Revoke surface is fenced to the platform owner (typically
  // `michael@bigsaas.ai`, configurable server-side via OWNER_SUPERADMIN_EMAIL).
  // Every other superadmin still has full panel access, they just can't
  // hand out or take away superadmin from other users.
  const refreshSupers = async () => {
    try {
      const r = await api.get("/admin/superadmins");
      setSuperadmins(r.data.items || []);
      setOwnerEmail(r.data.owner_email || null);
    } catch {
      // 403 for non-owner superadmins — expected. Hide the section.
      setSuperadmins(null);
    }
  };
  useEffect(() => { refreshSupers(); /* eslint-disable-next-line */ }, []);
  const isOwner = superadmins !== null;
  if (!data) return <div className="text-slate-500">Loading…</div>;
  const { users, companies, stats } = data;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="text-indigo-500" size={22} />
        <h1 className="font-heading text-3xl font-bold tracking-tight">Superadmin</h1>
        {isOwner && (
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setGrantOpen(true)}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
              data-testid="grant-superadmin-btn"
            >
              <ShieldPlus size={16} /> Grant Superadmin
            </button>
          </div>
        )}
      </div>
      {grantOpen && (
        <GrantSuperadminModal
          onClose={() => setGrantOpen(false)}
          onGranted={() => { refreshData(); refreshSupers(); }}
        />
      )}
      {isOwner && (
        <SuperadminsCard
          items={superadmins}
          ownerEmail={ownerEmail}
          onRevoked={() => { refreshData(); refreshSupers(); }}
        />
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          ["Users", stats.total_users, Users, "#6366F1"],
          ["Accounting Pros", stats.total_pros, Briefcase, "#3B82F6"],
          ["Clients", stats.total_clients, Users, "#10B981"],
          ["Companies", stats.total_companies, Building, "#8B5CF6"],
        ].map(([label, val, Icon, col]) => (
          <div key={label} className="rounded-xl border bg-white p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500">
              <Icon size={13} style={{ color: col }} /> {label}
            </div>
            <div className="font-heading text-3xl font-bold mt-1">{val}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-white overflow-hidden">
          <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-600">Users</div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b">
              <tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Email</th><th className="px-3 py-2 text-left">Role</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b">
                  <td className="px-3 py-1.5">{u.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{u.email}</td>
                  <td className="px-3 py-1.5">
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{u.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border bg-white overflow-hidden">
          <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-600">Companies</div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b">
              <tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2">Onboarded</th></tr>
            </thead>
            <tbody>
              {companies.map(c => (
                <tr key={c.id} className="border-b">
                  <td className="px-3 py-1.5">{c.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{c.business_type}</td>
                  <td className="px-3 py-1.5 text-center">{c.onboarding_complete ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <EnterprisesReport />

      <OrphanMembershipsCard />

      <AffiliatePayoutsCard />

      <div className="rounded-xl border bg-white p-5">
        <TeamPanel mode="admin" />
      </div>
    </div>
  );
}


// --------------------------------------------------------------------------
// EnterprisesReport — collapsible per-enterprise → per-client report on
// the Superadmin dashboard. Each enterprise row expands to show its
// clients (owner users); each client row expands to show its companies.
// One fetch of /admin/enterprises-report powers the whole thing.
// --------------------------------------------------------------------------
function EnterprisesReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openEnts, setOpenEnts] = useState({});
  const [openClients, setOpenClients] = useState({});

  useEffect(() => {
    api.get("/admin/enterprises-report")
      .then((r) => setRows(r.data?.rows || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  const toggleEnt = (id) => setOpenEnts((s) => ({ ...s, [id]: !s[id] }));
  const toggleClient = (id) => setOpenClients((s) => ({ ...s, [id]: !s[id] }));

  if (loading) return null;

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="superadmin-enterprises-report">
      <div className="px-4 py-2.5 bg-slate-50 border-b flex items-center gap-2">
        <Shield size={13} className="text-indigo-500" />
        <span className="text-xs uppercase font-semibold text-slate-600">Enterprises · clients · companies</span>
        <span className="text-[11px] text-slate-500 ml-auto">Click ▸ to expand</span>
      </div>
      {!rows.length ? (
        <div className="p-5 text-sm text-slate-500">No enterprises yet.</div>
      ) : (
        <ul className="divide-y">
          {rows.map(({ enterprise: ent, clients }) => {
            const open = !!openEnts[ent.id];
            return (
              <li key={ent.id} data-testid={`report-ent-${ent.id}`}>
                <button
                  onClick={() => toggleEnt(ent.id)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-slate-50 text-left"
                >
                  {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white flex-shrink-0">
                    <Shield size={10} />
                  </span>
                  <span className="font-medium text-sm">{ent.name}</span>
                  {ent.is_default && (
                    <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">Default</span>
                  )}
                  <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
                    <span><b className="text-slate-700 font-mono-num">{ent.pros_count}</b> pros</span>
                    <span><b className="text-slate-700 font-mono-num">{ent.clients_count}</b> clients</span>
                    <span><b className="text-slate-700 font-mono-num">{ent.companies_count}</b> companies</span>
                    <span className="text-slate-400">·</span>
                    <span>Free {ent.free_used}/{ent.free_user_allotment}</span>
                    <Link
                      to={`/admin/enterprises/${ent.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-cyan-700 hover:text-cyan-900 inline-flex items-center gap-0.5"
                    >
                      Open <ExternalLink size={10} />
                    </Link>
                  </span>
                </button>
                {open && (
                  <div className="bg-slate-50/50 border-t">
                    {!clients.length ? (
                      <div className="px-8 py-3 text-xs text-slate-500">No clients yet.</div>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {clients.map((cl) => {
                          const clOpen = !!openClients[cl.id];
                          return (
                            <li key={cl.id}>
                              <button
                                onClick={() => toggleClient(cl.id)}
                                className="w-full flex items-center gap-2 px-8 py-2 hover:bg-white text-left text-sm"
                                data-testid={`report-client-${cl.id}`}
                              >
                                {clOpen ? <ChevronDown size={12} className="text-slate-400" /> : <ChevronRight size={12} className="text-slate-400" />}
                                <Ticket size={11} className="text-cyan-600" />
                                <span className="font-medium">{cl.name || cl.email}</span>
                                <span className="text-[11px] text-slate-500 truncate">{cl.email}</span>
                                <span className="ml-auto text-[11px] text-slate-500">
                                  <b className="font-mono-num text-slate-700">{cl.company_count}</b> companies
                                </span>
                              </button>
                              {clOpen && cl.companies.length > 0 && (
                                <ul className="bg-white border-t border-slate-100 divide-y divide-slate-50">
                                  {cl.companies.map((c) => (
                                    <li key={c.id} className="px-12 py-1.5 text-[12px] flex items-center gap-2">
                                      <Building size={10} className="text-slate-400" />
                                      <span className="font-medium">{c.name}</span>
                                      <span className="text-slate-400 text-[10px]">{c.business_type || "—"}</span>
                                      {c.billing_product && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200">
                                          {c.billing_product}{c.billing_discount ? " · disc" : ""}
                                        </span>
                                      )}
                                      {c.billing_payer && (
                                        <span className="text-[10px] text-slate-600">· {c.billing_payer}</span>
                                      )}
                                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${
                                        c.billing_state === "active"  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                        : c.billing_state === "past_due" ? "bg-rose-50 text-rose-700 border-rose-200"
                                        : c.billing_state === "canceled" ? "bg-slate-100 text-slate-500 border-slate-300"
                                        :                                   "bg-amber-50 text-amber-700 border-amber-200"
                                      }`}>
                                        {c.billing_state}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- Grant Superadmin modal --------------------------------------
// Promotes an existing user (any role) to superadmin, or creates a fresh
// one from scratch. Fresh users get a magic-link welcome email so they
// set their own password on first sign-in — no plaintext credential ever
// leaves the platform. Every grant is audited server-side.
function GrantSuperadminModal({ onClose, onGranted }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const r = await api.post("/admin/superadmins", {
        email: email.trim(),
        name: name.trim() || null,
      });
      setResult(r.data);
      onGranted?.();
      if (r.data.already_superadmin) {
        toast.info(`${email} is already a superadmin.`);
      } else if (r.data.created) {
        toast.success(`Created superadmin — welcome email ${r.data.email_status === "sent" ? "sent" : "queued (see magic link below if needed)"}.`);
      } else {
        toast.success(`Promoted ${email} from ${r.data.previous_role || "user"} to superadmin.`);
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || "Grant failed.");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!result?.magic_url) return;
    try {
      await navigator.clipboard.writeText(result.magic_url);
      toast.success("Magic link copied.");
    } catch { toast.error("Copy failed — long-press to select."); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="grant-superadmin-modal">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center gap-2 px-5 py-4 border-b">
          <ShieldPlus size={18} className="text-indigo-500" />
          <h3 className="font-heading font-semibold">Grant Superadmin</h3>
          <button type="button" onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700" data-testid="grant-superadmin-close">
            <X size={18} />
          </button>
        </div>
        {!result && (
          <form onSubmit={submit} className="p-5 space-y-4">
            <p className="text-sm text-slate-500">
              Enter an email. If a user with that email already exists, their role becomes <span className="font-mono-num text-slate-700">superadmin</span>. If not, we'll create a fresh user and send them a magic-link welcome email so they set their own password.
            </p>
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-500 mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="michael@bigsaas.ai"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
                data-testid="grant-superadmin-email"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-500 mb-1">Name <span className="text-slate-400">(only used if creating a new user)</span></label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Michael Giorgi"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
                data-testid="grant-superadmin-name"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-3 py-2 rounded-md border border-slate-300 text-sm text-slate-700">Cancel</button>
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1"
                data-testid="grant-superadmin-submit"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldPlus size={14} />}
                Grant
              </button>
            </div>
          </form>
        )}
        {result && (
          <div className="p-5 space-y-4" data-testid="grant-superadmin-result">
            {result.already_superadmin && (
              <div className="text-sm text-slate-700">
                <span className="font-medium">{result.user.email}</span> was already a superadmin — nothing changed.
              </div>
            )}
            {!result.already_superadmin && !result.created && (
              <div className="text-sm text-slate-700">
                Promoted <span className="font-medium">{result.user.email}</span> from <span className="font-mono-num text-slate-500">{result.previous_role || "user"}</span> to <span className="font-mono-num text-indigo-600">superadmin</span>. They can access the superadmin panel on their next page load.
              </div>
            )}
            {result.created && (
              <>
                <div className="text-sm text-slate-700">
                  Created new superadmin <span className="font-medium">{result.user.email}</span>. A welcome email with a magic-link password setter has been {result.email_status === "sent" ? "sent" : "attempted"}.
                </div>
                {result.email_status !== "sent" && result.magic_url && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <div className="text-xs font-medium text-amber-800">
                      Email delivery {result.email_status}. Copy this magic link and send it manually:
                    </div>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={result.magic_url}
                        className="flex-1 text-xs rounded border border-amber-300 bg-white px-2 py-1.5 font-mono-num text-slate-700"
                      />
                      <button
                        type="button"
                        onClick={copyLink}
                        className="px-2 py-1.5 rounded bg-amber-600 text-white text-xs font-medium flex items-center gap-1"
                        data-testid="grant-superadmin-copy-link"
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => { setResult(null); setEmail(""); setName(""); }}
                className="px-3 py-2 rounded-md border border-slate-300 text-sm text-slate-700"
              >
                Grant another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="ml-2 px-3 py-2 rounded-md bg-slate-900 text-white text-sm font-medium"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ---------- Superadmins list w/ per-row revoke -------------------------
// Only rendered when the caller is the platform owner. The owner row
// itself shows a locked "Owner" badge instead of the revoke button so
// no one accidentally locks the platform out of granting new
// superadmins.
function SuperadminsCard({ items, ownerEmail, onRevoked }) {
  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="superadmins-report">
      <div className="px-5 py-3 border-b flex items-center gap-2">
        <Shield size={16} className="text-indigo-500" />
        <h2 className="font-heading font-semibold">Superadmins</h2>
        <div className="ml-auto text-xs text-slate-500">
          {items.length} active · owner: <span className="font-mono-num text-slate-700">{ownerEmail}</span>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left">Name</th>
            <th className="px-4 py-2 text-left">Email</th>
            <th className="px-4 py-2 text-left">Since</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <SuperadminRow key={r.id} row={r} onRevoked={onRevoked} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuperadminRow({ row, onRevoked }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/superadmins/${row.id}/revoke`);
      toast.success(`${row.email} demoted to pro.`);
      setConfirming(false);
      onRevoked?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Revoke failed.");
    } finally { setBusy(false); }
  };
  const since = row.created_at ? new Date(row.created_at).toLocaleDateString() : "—";
  return (
    <tr className="border-t hover:bg-slate-50" data-testid={`superadmin-row-${row.id}`}>
      <td className="px-4 py-3 font-medium text-slate-800">{row.name || "—"}</td>
      <td className="px-4 py-3 font-mono-num text-slate-600">{row.email}</td>
      <td className="px-4 py-3 text-slate-500">{since}</td>
      <td className="px-4 py-3 text-right">
        {row.is_owner ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-700 px-2.5 py-1 text-[11px] font-medium">
            <Shield size={12} /> Owner — cannot revoke
          </span>
        ) : confirming ? (
          <div className="inline-flex items-center gap-2">
            <span className="text-xs text-slate-500">Revoke superadmin?</span>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-red-600 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-50"
              data-testid={`superadmin-row-${row.id}-confirm`}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldMinus size={12} />}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 text-slate-700 hover:bg-red-50 hover:border-red-300 hover:text-red-700 px-2.5 py-1 text-xs font-medium"
            data-testid={`superadmin-row-${row.id}-revoke`}
          >
            <ShieldMinus size={12} /> Revoke
          </button>
        )}
      </td>
    </tr>
  );
}



// --------------------------------------------------------------------------
// OrphanMembershipsCard — data-drift lens for superadmins. Reads
// /admin/orphan-memberships and lets the operator run two cleanup
// actions (elevate role drift + purge duplicate memberships).
// --------------------------------------------------------------------------
function OrphanMembershipsCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/admin/orphan-memberships");
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't load orphan report");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const runFix = async (label, endpoint) => {
    setBusy(endpoint);
    try {
      const r = await api.post(endpoint);
      const detail = Object.entries(r.data)
        .map(([k, v]) => `${k}=${v}`).join(", ");
      toast.success(`${label}: ${detail}`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't run");
    } finally { setBusy(""); }
  };

  if (!data && !loading) return null;

  const t = data?.totals || {};
  const totalIssues = Object.values(t).reduce((a, b) => a + b, 0);

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="orphan-card">
      <div className="px-4 py-3 bg-slate-50 border-b flex items-center gap-3">
        <AlertTriangle size={16} className={totalIssues ? "text-amber-500" : "text-emerald-500"} />
        <div className="font-semibold text-slate-700">Data health · orphan memberships</div>
        {totalIssues > 0 ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
            {totalIssues} finding{totalIssues === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
            All clean
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border hover:bg-slate-50 disabled:opacity-50"
            data-testid="orphan-refresh"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="p-6 text-sm text-slate-500">Scanning memberships…</div>
      ) : (
        <div className="divide-y">
          <OrphanRow
            label="Multi-firm firm-staff"
            hint="A single user is a pro on client companies belonging to two or more different firms. Legit for contractors, but often a lingering invite that was never revoked."
            items={data.multi_firm_staff}
            columns={["email", "firm_count", "companies"]}
            open={open.multi} onToggle={() => setOpen(s => ({ ...s, multi: !s.multi }))}
            testId="orphan-multi"
          />
          <OrphanRow
            label="Role drift · client with pro memberships"
            hint="user.role='client' but they hold at least one active pro membership. Fix upgrades their global role to pro."
            items={data.role_mismatch_client_but_pro}
            columns={["email", "name"]}
            open={open.roleC} onToggle={() => setOpen(s => ({ ...s, roleC: !s.roleC }))}
            testId="orphan-role-client"
            action={data.role_mismatch_client_but_pro.length > 0 && (
              <button
                onClick={() => runFix("Elevated role drift", "/admin/orphan-memberships/fix-role-drift")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                data-testid="orphan-fix-role-drift"
              >
                {busy === "/admin/orphan-memberships/fix-role-drift"
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Wrench size={12} />}
                Elevate to pro
              </button>
            )}
          />
          <OrphanRow
            label="Dangling pro role · no active memberships"
            hint="user.role='pro' but they have zero active pro memberships. Sidebar shows an empty Clients list. Consider removing pro role or re-inviting them."
            items={data.role_mismatch_pro_but_no_pro_ms}
            columns={["email", "name"]}
            open={open.roleP} onToggle={() => setOpen(s => ({ ...s, roleP: !s.roleP }))}
            testId="orphan-role-pro"
          />
          <OrphanRow
            label="Archived memberships still on file"
            hint="Memberships with archived_at set. Kept for audit history; hard-delete only if you're sure the audit trail is no longer needed."
            items={data.dangling_archived}
            columns={["email", "company_name", "role", "archived_at"]}
            open={open.arch} onToggle={() => setOpen(s => ({ ...s, arch: !s.arch }))}
            testId="orphan-archived"
          />
          <OrphanRow
            label="Duplicate memberships"
            hint="Same (user_id, company_id, role) appears more than once — historical seed-script residue. Purge keeps the oldest record."
            items={data.duplicate_memberships}
            columns={["email", "company_name", "role", "count"]}
            open={open.dup} onToggle={() => setOpen(s => ({ ...s, dup: !s.dup }))}
            testId="orphan-duplicates"
            action={data.duplicate_memberships.length > 0 && (
              <button
                onClick={() => runFix("Duplicates purged", "/admin/orphan-memberships/purge-duplicates")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                data-testid="orphan-purge-duplicates"
              >
                {busy === "/admin/orphan-memberships/purge-duplicates"
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Wrench size={12} />}
                Purge duplicates
              </button>
            )}
          />
        </div>
      )}
    </div>
  );
}

function OrphanRow({ label, hint, items, columns, open, onToggle, testId, action }) {
  const count = items?.length || 0;
  return (
    <div data-testid={testId}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left"
      >
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-700 truncate">{label}</div>
          <div className="text-xs text-slate-500 truncate">{hint}</div>
        </div>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
          count === 0 ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-800"
        }`}>{count}</span>
        {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
      </button>
      {open && count > 0 && (
        <div className="border-t bg-slate-50/50 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 border-b">
              <tr>
                {columns.map(c => (
                  <th key={c} className="px-3 py-1.5 text-left font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b last:border-b-0">
                  {columns.map(c => (
                    <td key={c} className="px-3 py-1.5 text-slate-600 whitespace-nowrap">
                      {c === "companies"
                        ? (it[c] || []).map(cc => cc.name).filter(Boolean).join(", ")
                        : (it[c] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}



// --------------------------------------------------------------------------
// AffiliatePayoutsCard — superadmin payout console. Roll-up of what's
// owed to each affiliate + a modal to mark accrued invoices paid_out
// once a Wise/check transfer has cleared. History pane surfaces recent
// batches so admins can trace "who paid who what when".
// --------------------------------------------------------------------------
function AffiliatePayoutsCard() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // { referrer } | null
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [ov, hs] = await Promise.all([
        api.get("/admin/affiliate/payouts"),
        api.get("/admin/affiliate/history?limit=20"),
      ]);
      setData(ov.data);
      setHistory(hs.data.batches || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't load payouts");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (!data && !loading) return null;
  const t = data?.totals || {};

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="payouts-card">
      <div className="px-4 py-3 bg-slate-50 border-b flex items-center gap-3">
        <DollarSign size={16} className="text-emerald-600" />
        <div className="font-semibold text-slate-700">Affiliate payouts</div>
        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
          {fmtUsd(t.accrued_cents)} to pay · {t.affiliates_needing_payout || 0} affiliate
          {(t.affiliates_needing_payout || 0) === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-slate-500 hidden md:inline">
          Lifetime: {fmtUsd(t.lifetime_cents)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border hover:bg-slate-50 disabled:opacity-50"
            data-testid="payouts-refresh"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="p-6 text-sm text-slate-500">Loading payout ledger…</div>
      ) : (data.affiliates || []).length === 0 ? (
        <div className="p-8 text-center">
          <div className="text-slate-700 font-medium">No affiliate earnings yet</div>
          <div className="text-sm text-slate-500 mt-1">
            When paying subscribers come in via a referral link, this ledger will fill up.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white text-xs uppercase tracking-wide text-slate-500 border-b">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Affiliate</th>
                <th className="px-4 py-2 text-left font-medium">Slug</th>
                <th className="px-4 py-2 text-right font-medium">Payers</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 text-right font-medium">Accrued</th>
                <th className="px-4 py-2 text-right font-medium">Paid</th>
                <th className="px-4 py-2 text-left font-medium">Last activity</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.affiliates.map(a => (
                <tr key={a.referrer_user_id} data-testid={`payouts-row-${a.referrer_user_id}`}>
                  <td className="px-4 py-2.5">
                    <div className="text-slate-800 font-medium">{a.name || "—"}</div>
                    <div className="text-[11px] text-slate-500">
                      {a.email}
                      {a.firm_name ? <> · <span className="text-cyan-700">{a.firm_name}</span></> : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[11px] font-mono text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">
                      {a.referral_slug || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{a.unique_payers}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    <span title="Accrued invoices">{a.accrued_count}</span>
                    {a.paid_count > 0 && (
                      <span className="text-slate-400"> · {a.paid_count} paid</span>
                    )}
                  </td>
                  <td className={
                    "px-4 py-2.5 text-right tabular-nums font-medium " +
                    (a.accrued_cents > 0 ? "text-amber-700" : "text-slate-400")
                  }>
                    {fmtUsd(a.accrued_cents)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">
                    {fmtUsd(a.paid_out_cents)}
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-slate-500">
                    {fmtDateShort(a.last_activity)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => setModal({ referrer: a })}
                      disabled={!a.needs_payout}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 disabled:hover:bg-white"
                      data-testid={`payouts-mark-paid-${a.referrer_user_id}`}
                    >
                      <CheckCircle2 size={12} /> Mark paid
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        onClick={() => setHistoryOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 border-t text-xs"
        data-testid="payouts-history-toggle"
      >
        <span className="flex items-center gap-1.5">
          {historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="uppercase tracking-widest text-slate-500 font-semibold">
            History
          </span>
          <span className="text-slate-400">({history.length})</span>
        </span>
      </button>
      {historyOpen && (
        <div className="border-t divide-y bg-slate-50/40" data-testid="payouts-history-list">
          {history.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No payouts recorded yet.</div>
          ) : (
            history.map(b => (
              <div key={b.id} className="px-4 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="font-medium text-slate-800">
                      {fmtUsd(b.amount_cents)}
                    </span>
                    <span className="text-slate-500"> to </span>
                    <span className="font-medium text-slate-700">
                      {b.referrer?.name || b.referrer?.email || "—"}
                    </span>
                    <span className="text-slate-500"> · {b.invoice_count} invoice{b.invoice_count === 1 ? "" : "s"}</span>
                  </div>
                  <div className="text-slate-500">{fmtDateShort(b.paid_at)}</div>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  by {b.paid_by?.name || b.paid_by?.email || "—"}
                  {b.external_ref && <> · <span className="font-mono">{b.external_ref}</span></>}
                  {b.note && <> · {b.note}</>}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {modal && (
        <MarkPaidModal
          referrer={modal.referrer}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function MarkPaidModal({ referrer, onClose, onDone }) {
  const [lines, setLines] = useState(null);
  const [selected, setSelected] = useState(null); // Set of earning IDs, null = all
  const [externalRef, setExternalRef] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/admin/affiliate/payouts/${referrer.referrer_user_id}?status=accrued`)
      .then(r => setLines(r.data.lines || []))
      .catch(() => setLines([]));
  }, [referrer.referrer_user_id]);

  const isAll = selected === null;
  const effectiveIds = isAll ? (lines || []).map(l => l.id) : Array.from(selected);
  const totalCents = (lines || [])
    .filter(l => effectiveIds.includes(l.id))
    .reduce((s, l) => s + l.share_cents, 0);

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev ?? (lines || []).map(l => l.id));
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (effectiveIds.length === 0) return;
    setBusy(true);
    try {
      const body = {
        referrer_user_id: referrer.referrer_user_id,
        earning_ids: isAll ? null : effectiveIds,
        external_ref: externalRef.trim() || null,
        note: note.trim() || null,
      };
      const r = await api.post("/admin/affiliate/payouts/mark-paid", body);
      toast.success(`Marked ${r.data.marked} invoice${r.data.marked === 1 ? "" : "s"} paid (${fmtUsd(r.data.amount_cents)})`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't mark paid");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden" data-testid="mark-paid-modal">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <div className="font-semibold text-slate-800">
              Mark paid — {referrer.name || referrer.email}
            </div>
            <div className="text-xs text-slate-500">
              Records the transfer in the ledger. Reversible if a payment bounces.
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"
                  data-testid="mark-paid-close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {lines === null ? (
            <div className="text-sm text-slate-500">
              <Loader2 size={14} className="inline animate-spin mr-2" /> Loading invoices…
            </div>
          ) : lines.length === 0 ? (
            <div className="text-sm text-slate-500">No accrued invoices for this affiliate.</div>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">
                  {effectiveIds.length} of {lines.length} invoice{lines.length === 1 ? "" : "s"} selected
                </span>
                <button
                  onClick={() => setSelected(isAll ? new Set() : null)}
                  className="text-cyan-700 hover:underline"
                  data-testid="mark-paid-toggle-all"
                >
                  {isAll ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div className="border rounded-md divide-y max-h-56 overflow-y-auto">
                {lines.map(l => {
                  const on = isAll || (selected && selected.has(l.id));
                  return (
                    <label
                      key={l.id}
                      className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(l.id)}
                        data-testid={`mark-paid-line-${l.id}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-700 truncate">
                          {l.referred_email || "—"}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {fmtDateShort(l.date)} · gross {fmtUsd(l.gross_cents)}
                        </div>
                      </div>
                      <div className="text-emerald-700 font-medium tabular-nums">
                        {fmtUsd(l.share_cents)}
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <div className="text-xs text-slate-600 mb-1">External reference (optional)</div>
                  <input
                    value={externalRef}
                    onChange={e => setExternalRef(e.target.value)}
                    placeholder="Wise TX, check #, etc."
                    className="w-full border rounded px-2 py-1.5 text-sm"
                    data-testid="mark-paid-external-ref"
                  />
                </label>
                <label className="block">
                  <div className="text-xs text-slate-600 mb-1">Note (optional)</div>
                  <input
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Feb 2026 batch"
                    className="w-full border rounded px-2 py-1.5 text-sm"
                    data-testid="mark-paid-note"
                  />
                </label>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 flex items-center justify-between">
          <div className="text-sm">
            <span className="text-slate-500">Total to pay: </span>
            <span className="font-heading font-bold text-emerald-700 tabular-nums">
              {fmtUsd(totalCents)}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border hover:bg-white"
            >Cancel</button>
            <button
              onClick={submit}
              disabled={busy || effectiveIds.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              data-testid="mark-paid-submit"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              Mark {effectiveIds.length} paid
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtUsd(cents) {
  return `$${(((cents ?? 0)) / 100).toFixed(2)}`;
}
function fmtDateShort(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "2-digit" });
  } catch { return iso; }
}

