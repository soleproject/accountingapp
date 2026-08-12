import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  ArrowLeft, Loader2, Users as UsersIcon, Building, Handshake,
  BookOpen, ExternalLink, Edit3,
} from "lucide-react";
import { WhitelabelCompToggle } from "@/pages/AdminEnterpriseDetail";

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
  const brandColor = p.primary_color || "#c026d3";

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
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 font-medium">
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
        <StatBox label="Enterprises" value={stats.enterprises ?? 0} tone="fuchsia" Icon={Handshake} />
        <StatBox
          label="Partner Books"
          value={stats.has_partner_books ? "1" : "—"}
          tone="emerald"
          Icon={BookOpen}
        />
      </div>

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
                    whitelabel_unlocked: pro.whitelabel_unlocked,
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
        <div className="flex items-center gap-2 border-b border-slate-100 p-4">
          <Building size={16} className="text-slate-500" />
          <h2 className="text-lg font-semibold text-slate-900">
            Companies ({data.companies.length})
          </h2>
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
    </div>
  );
}
