import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import {
  Users, Building, Briefcase, Shield, ChevronRight, ChevronDown,
  Ticket, ExternalLink,
} from "lucide-react";
import TeamPanel from "@/components/TeamPanel";

export default function SuperadminDash() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get("/admin/overview").then(r => setData(r.data)); }, []);
  if (!data) return <div className="text-slate-500">Loading…</div>;
  const { users, companies, stats } = data;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="text-indigo-500" size={22} />
        <h1 className="font-heading text-3xl font-bold tracking-tight">Superadmin</h1>
      </div>
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
