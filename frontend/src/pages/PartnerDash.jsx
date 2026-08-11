import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import {
  Handshake, Building, Users as UsersIcon, ExternalLink, Loader2,
  Plus, RefreshCw, BookOpen, Palette, UserPlus, Shield,
} from "lucide-react";
import { NewClientModal, NewEnterpriseModal } from "@/pages/ProClients";

/**
 * Partner Dashboard — the landing page for a logged-in Partner user.
 *
 * Data source: `GET /api/partner/summary` + `/partner/clients` +
 * `/partner/enterprises` (partner-scoped on the server — Partner A
 * cannot see Partner B's rows).
 *
 * Layout: brand header + 4 stat cards + Partner Books tile + a
 * "My Clients" section with a Clients | Enterprises toggle (mirrors
 * the Superadmin `/pro/clients` toggle UX). The relevant "New Client"
 * or "New Enterprise" button lives on the header of the section and
 * swaps with the toggle.
 *
 * The modals themselves are reused from ProClients (exported) so the
 * create UX is identical to what Pros + Superadmins already know.
 * Backend endpoints (`POST /pro/clients`, `POST /admin/enterprises`)
 * were extended to accept `role=partner` and auto-stamp `partner_id`
 * on the created row so the scoping filters find them.
 */

function StatCard({ label, value, Icon, tone = "indigo" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    slate: "bg-slate-50 text-slate-700 border-slate-200",
  };
  return (
    <div
      data-testid={`partner-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex items-center gap-2">
        <div className={`inline-flex h-8 w-8 items-center justify-center rounded-md border ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-xs uppercase tracking-wider text-slate-500">
          {label}
        </div>
      </div>
      <div className="mt-2 font-heading text-3xl font-bold text-slate-900">
        {value ?? 0}
      </div>
    </div>
  );
}

export default function PartnerDash() {
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState("");
  const [clients, setClients] = useState([]);
  const [enterprises, setEnterprises] = useState([]);
  // My Clients section — toggle state. `clients` (default) shows the
  // client-companies list; `enterprises` shows the enterprises list.
  const [mode, setMode] = useState("clients");
  const [creatingClient, setCreatingClient] = useState(false);
  const [creatingEnterprise, setCreatingEnterprise] = useState(false);
  const nav = useNavigate();

  async function load() {
    setErr("");
    try {
      const [s, c, e] = await Promise.all([
        api.get("/partner/summary"),
        api.get("/partner/clients"),
        api.get("/partner/enterprises"),
      ]);
      setSummary(s.data);
      setClients(c.data.clients || []);
      setEnterprises(e.data.enterprises || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load");
    }
  }

  useEffect(() => { load(); }, []);

  if (!summary && !err) {
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

  const p = summary.partner;
  const s = p.stats || {};
  const brandColor = p.primary_color || "#c026d3";

  return (
    <div data-testid="partner-dashboard" className="mx-auto max-w-6xl px-4 py-6 space-y-6">
      {/* Header — branded to the partner */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold text-white"
          style={{ backgroundColor: brandColor }}
        >
          {(p.display_name || p.name || "?").charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            {p.display_name || p.name}
          </h1>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Handshake className="h-3.5 w-3.5" />
            Partner dashboard
            {p.subdomain && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                {p.subdomain}.accountingapp.ai
              </span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            className="rounded-md border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <Link
            to="/pro/settings"
            data-testid="partner-settings"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Palette className="h-4 w-4" />
            Branding
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Clients" value={s.clients} Icon={UsersIcon} tone="indigo" />
        <StatCard label="Enterprises" value={s.enterprises} Icon={Building} tone="emerald" />
        <StatCard label="Users" value={s.linked_users} Icon={UsersIcon} tone="slate" />
        <StatCard
          label="Partner Books"
          value={s.has_partner_books ? "1" : "—"}
          Icon={BookOpen}
          tone="amber"
        />
      </div>

      {/* Partner Books tile */}
      {s.has_partner_books && s.partner_books_company_id && (
        <button
          onClick={() => nav(`/companies/${s.partner_books_company_id}`)}
          data-testid="partner-books-tile"
          className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/50 p-4 text-left transition hover:border-indigo-400 hover:bg-indigo-50"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-indigo-100 text-indigo-700">
            <BookOpen className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-700">
                Your firm
              </span>
            </div>
            <div className="font-semibold text-slate-900">
              {p.display_name || p.name} — Partner Books
            </div>
            <div className="text-xs text-slate-500">
              Your own accounting books · click to open
            </div>
          </div>
          <ExternalLink className="h-4 w-4 text-indigo-500" />
        </button>
      )}

      {/* My Clients section — toggle-based, mirrors the Superadmin
          `/pro/clients` pattern but drops the "Partners" toggle option
          (a Partner cannot create other Partners). */}
      <section
        data-testid="partner-my-clients"
        className="rounded-xl border border-slate-200 bg-white"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">My Clients</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {mode === "enterprises"
                ? "Enterprises you've provisioned under your partner brand."
                : "Client companies you manage — onboarding status + activity at a glance."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              data-testid="partner-my-clients-toggle"
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5"
            >
              <button
                onClick={() => setMode("clients")}
                data-testid="partner-toggle-clients"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
                  mode === "clients" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <UsersIcon size={11} /> Clients
              </button>
              <button
                onClick={() => setMode("enterprises")}
                data-testid="partner-toggle-enterprises"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
                  mode === "enterprises" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Shield size={11} /> Enterprises
              </button>
            </div>
            {mode === "clients" ? (
              <button
                data-testid="partner-new-client-btn"
                onClick={() => setCreatingClient(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                <UserPlus size={14} /> New Client
              </button>
            ) : (
              <button
                data-testid="partner-new-enterprise-btn"
                onClick={() => setCreatingEnterprise(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                <Shield size={14} /> New Enterprise
              </button>
            )}
          </div>
        </div>

        <div className="p-4">
          {mode === "clients" ? (
            clients.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 py-8 text-center text-sm text-slate-500">
                No clients yet. Click <span className="font-medium text-slate-700">New Client</span> above to onboard your first one.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {clients.map((c) => (
                  <Link
                    key={c.id}
                    to={`/companies/${c.id}`}
                    data-testid={`partner-client-row-${c.id}`}
                    className="flex items-center gap-3 p-3 hover:bg-slate-50 rounded-md"
                  >
                    <Building className="h-4 w-4 text-slate-400" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{c.name}</div>
                      <div className="text-xs text-slate-500">{c.business_type || "—"}</div>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
                  </Link>
                ))}
              </div>
            )
          ) : enterprises.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 py-8 text-center text-sm text-slate-500">
              No enterprises yet. Click <span className="font-medium text-slate-700">New Enterprise</span> above to provision your first one.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {enterprises.map((e) => (
                <div
                  key={e.id}
                  data-testid={`partner-enterprise-row-${e.id}`}
                  className="flex items-center gap-3 p-3"
                >
                  <Building className="h-4 w-4 text-slate-400" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{e.name}</div>
                    <div className="text-xs text-slate-500 font-mono">
                      {e.slug || "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="text-xs text-slate-400">
        Updated {new Date(summary.generated_at).toLocaleString()}
      </div>

      {creatingClient && (
        <NewClientModal
          onClose={() => setCreatingClient(false)}
          onCreated={async () => { await load(); setCreatingClient(false); }}
        />
      )}
      {creatingEnterprise && (
        <NewEnterpriseModal
          onClose={() => setCreatingEnterprise(false)}
          onCreated={async () => { await load(); setCreatingEnterprise(false); }}
        />
      )}
    </div>
  );
}
