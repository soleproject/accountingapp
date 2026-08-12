import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import {
  Handshake, Building, Users as UsersIcon, ExternalLink, Loader2,
  Plus, RefreshCw, BookOpen, Palette, UserPlus, Shield,
  DollarSign, TrendingUp, Cpu,
} from "lucide-react";
import { NewClientModal, NewEnterpriseModal } from "@/pages/ProClients";
import { toast } from "sonner";

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

// ---------------------------------------------------------------------------
// Financials tiles + trend — the "$-value" rollup that sits below the entity
// count StatCards. Three cards on top (Usage, Revenue, Margin) and a simple
// bar-trend for the last N months.
// ---------------------------------------------------------------------------

function fmtUSD(cents) {
  const dollars = (Number(cents) || 0) / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function fmtMonth(monthKey) {
  // "2026-02" → "Feb"
  const [y, m] = String(monthKey || "").split("-");
  const d = new Date(Number(y || 0), Number(m || 1) - 1, 1);
  return d.toLocaleString("en-US", { month: "short" });
}

function MoneyTile({ label, cents, sub, Icon, tone, testid }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <div
      data-testid={testid}
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex items-center gap-2">
        <div className={`inline-flex h-8 w-8 items-center justify-center rounded-md border ${tones[tone] || tones.indigo}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      </div>
      <div className="mt-2 font-heading text-3xl font-bold text-slate-900 tabular-nums">
        {fmtUSD(cents)}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function TrendBars({ trend }) {
  const max = Math.max(
    1,
    ...trend.map((t) => Math.max(t.usage_cents || 0, t.revenue_cents || 0)),
  );
  return (
    <div className="grid grid-cols-3 gap-4" data-testid="partner-financials-trend">
      {trend.map((t) => {
        const uh = Math.max(4, Math.round(((t.usage_cents || 0) / max) * 96));
        const rh = Math.max(4, Math.round(((t.revenue_cents || 0) / max) * 96));
        return (
          <div key={t.month_key} className="flex flex-col items-center gap-2">
            <div className="flex h-24 items-end gap-2">
              <div
                className="w-6 rounded-t bg-indigo-400"
                style={{ height: `${uh}px` }}
                title={`Usage · ${fmtUSD(t.usage_cents)}`}
              />
              <div
                className="w-6 rounded-t bg-emerald-500"
                style={{ height: `${rh}px` }}
                title={`Revenue · ${fmtUSD(t.revenue_cents)}`}
              />
            </div>
            <div className="text-xs font-medium text-slate-700">{fmtMonth(t.month_key)}</div>
            <div className="flex items-center gap-2 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-indigo-400" />
                {fmtUSD(t.usage_cents)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-emerald-500" />
                {fmtUSD(t.revenue_cents)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ServiceBreakdown({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="text-xs text-slate-400">No AI/service spend this month yet.</div>
    );
  }
  const total = rows.reduce((s, r) => s + (r.cents || 0), 0);
  return (
    <div className="space-y-1.5" data-testid="partner-financials-by-service">
      {rows.slice(0, 5).map((r) => {
        const pct = total > 0 ? Math.round((r.cents / total) * 100) : 0;
        return (
          <div key={r.service} className="grid grid-cols-[1fr_auto] items-center gap-3">
            <div className="min-w-0">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-slate-700">{r.service}</span>
                <span className="tabular-nums text-slate-500">{fmtUSD(r.cents)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-100">
                <div
                  className="h-full rounded bg-indigo-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EnterpriseRow — clickable row that navigates to the enterprise detail page
// AND surfaces an inline "Comp WL" toggle for the enterprise owner. The row
// itself is a <Link>; the toggle intercepts clicks with stopPropagation so
// tapping the toggle doesn't also navigate.
//
// The toggle is only rendered when the enterprise has an owner (there's no
// user to comp otherwise). At the quota cap, un-checked rows disable the
// toggle so the partner can't blow past 2 comps.
// ---------------------------------------------------------------------------
function EnterpriseRow({ ent, wlComps, onToggle }) {
  const [busy, setBusy] = useState(false);
  const isComped = !!ent.owner_whitelabel_comp;
  const hasOwner = !!ent.owner_user_id;
  const remaining = wlComps ? wlComps.remaining : null;
  // When the row's own state IS "comped", the toggle must stay
  // enabled regardless of `remaining` — revoking is unbounded.
  const disabled =
    busy ||
    !hasOwner ||
    (!isComped && remaining !== null && remaining <= 0);

  const flip = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setBusy(true);
    try {
      await api.post(`/admin/pros/${ent.owner_user_id}/whitelabel-comp`, {
        granted: !isComped,
      });
      toast.success(
        isComped
          ? "White-label comp revoked."
          : "White-label comp applied.",
      );
      onToggle && (await onToggle());
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err.message || "Toggle failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid={`partner-enterprise-row-${ent.id}`}
      className="flex items-center gap-3 p-3 hover:bg-slate-50 rounded-md"
    >
      <Link
        to={`/admin/enterprises/${ent.id}`}
        className="flex flex-1 items-center gap-3 min-w-0"
        data-testid={`partner-enterprise-link-${ent.id}`}
      >
        <Building className="h-4 w-4 text-slate-400" />
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">
            {ent.name}
          </div>
          <div className="text-xs text-slate-500 font-mono">
            {ent.slug || "—"}
          </div>
        </div>
      </Link>
      {/* Inline WL-comp toggle — only shown when there's an owner to
          comp. Uses a compact pill-style switch styled after the
          existing shadcn Switch to feel native. */}
      {hasOwner && (
        <button
          type="button"
          onClick={flip}
          disabled={disabled}
          aria-pressed={isComped}
          data-testid={`partner-enterprise-wl-toggle-${ent.id}`}
          title={
            !hasOwner
              ? "This enterprise has no owner to comp."
              : isComped
                ? "Click to revoke this owner's white-label comp"
                : remaining !== null && remaining <= 0
                  ? "No comps remaining — revoke one before granting another."
                  : "Comp this owner's white-label"
          }
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors border ${
            isComped
              ? "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
              : "bg-white text-slate-600 border-slate-300 hover:bg-slate-100"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isComped ? "bg-white" : "bg-slate-400"
            }`}
          />
          {isComped ? "WL comped" : "Comp WL"}
        </button>
      )}
      <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
    </div>
  );
}


export default function PartnerDash() {
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState("");
  const [clients, setClients] = useState([]);
  const [enterprises, setEnterprises] = useState([]);
  const [financials, setFinancials] = useState(null);
  // My Clients section — toggle state. `clients` (default) shows the
  // client-companies list; `enterprises` shows the enterprises list.
  const [mode, setMode] = useState("clients");
  const [creatingClient, setCreatingClient] = useState(false);
  const [creatingEnterprise, setCreatingEnterprise] = useState(false);
  const nav = useNavigate();

  async function load() {
    setErr("");
    try {
      // Summary / clients / enterprises are essential and must all
      // succeed. Financials + wl-comps are soft-required — if the
      // endpoint fails (older backend, transient error) we still
      // render the rest of the dashboard.
      const [s, c, e] = await Promise.all([
        api.get("/partner/summary"),
        api.get("/partner/clients"),
        api.get("/partner/enterprises"),
      ]);
      setSummary(s.data);
      setClients(c.data.clients || []);
      setEnterprises(e.data.enterprises || []);
      try {
        const [f, w] = await Promise.all([
          api.get("/partner/financials?months=3"),
          api.get("/partner/wl-comps"),
        ]);
        // Piggy-back the wl-comp quota onto financials so a single
        // state slot carries all the "meta" the UI needs.
        setFinancials({ ...f.data, _wlComps: w.data });
      } catch {
        setFinancials(null);
      }
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

      {/* Financials rollup — $-value Usage / Revenue / Margin scoped
          to this Partner's tree. Loaded lazily; if the API errored we
          still render the rest of the dashboard, this section just
          stays absent so users aren't blocked. */}
      {financials && (
        <section
          data-testid="partner-financials"
          className="rounded-xl border border-slate-200 bg-white"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">
                Financials
              </h2>
              <p className="text-xs text-slate-500">
                Current month ({fmtMonth(financials.current_month_key)}) · {financials.tree_summary?.company_count || 0} companies · {financials.tree_summary?.enterprise_count || 0} enterprises
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
            <MoneyTile
              testid="partner-usage-tile"
              label="Usage"
              cents={financials.usage_cents_current}
              sub="AI + service spend consumed by your tree"
              Icon={Cpu}
              tone="indigo"
            />
            <MoneyTile
              testid="partner-revenue-tile"
              label="Revenue"
              cents={financials.revenue_cents_current}
              sub="Consolidated invoices billed this month"
              Icon={DollarSign}
              tone="emerald"
            />
            <MoneyTile
              testid="partner-margin-tile"
              label="Margin"
              cents={(financials.revenue_cents_current || 0) - (financials.usage_cents_current || 0)}
              sub="Revenue − Usage (before Stripe / platform fees)"
              Icon={TrendingUp}
              tone={(financials.revenue_cents_current || 0) >= (financials.usage_cents_current || 0) ? "emerald" : "rose"}
            />
          </div>
          <div className="grid grid-cols-1 gap-6 border-t border-slate-100 p-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Last 3 months
              </div>
              <TrendBars trend={financials.trend || []} />
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Where usage went ({fmtMonth(financials.current_month_key)})
              </div>
              <ServiceBreakdown rows={financials.by_service_current || []} />
            </div>
          </div>
        </section>
      )}

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
                <EnterpriseRow
                  key={e.id}
                  ent={e}
                  wlComps={financials?._wlComps || null}
                  onToggle={async () => {
                    // Reload the full list so the counter + row state
                    // update from a single authoritative source.
                    await load();
                  }}
                />
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
