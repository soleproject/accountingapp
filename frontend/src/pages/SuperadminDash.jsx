import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import {
  Users, Building, Briefcase, Shield, ChevronRight, ChevronDown,
  Ticket, ExternalLink, ShieldPlus, X, Loader2, Copy, ShieldMinus,
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

