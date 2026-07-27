import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import {
  AlertTriangle, CheckCircle2, ArrowRight, Plus, X, Loader2, UserPlus,
  BellRing, Wand2, FileWarning, ReceiptText, ScrollText, Sparkles, MailPlus,
  Building2, Shield, Users2, Palette, Link as LinkIcon, Gift, Ticket, CreditCard,
  Search, LayoutGrid, List as ListIcon,
} from "lucide-react";
import { toast } from "sonner";

export default function ProClients() {
  const [clients, setClients] = useState([]);
  const [firm, setFirm] = useState(null);
  const [creating, setCreating] = useState(false);
  // Superadmin-only: open the "Add Enterprise" modal from the header on
  // the Enterprises tab. On success we re-run the enterprises fetch so
  // the new record shows up immediately in the grid without a reload.
  const [creatingEnterprise, setCreatingEnterprise] = useState(false);
  // Superadmin-only: "Open" button on an enterprise card impersonates
  // the owner Pro — fresh JWT from `/admin/impersonate/{uid}`, cache
  // the previous superadmin token so `<ImpersonateBanner>` can flip
  // back with one click.
  const openAsOwner = async (ent) => {
    if (!ent?.owner_user_id) return;
    try {
      const r = await api.post(`/admin/impersonate/${ent.owner_user_id}`);
      const newTok = r.data?.token;
      const newUsr = r.data?.user;
      if (!newTok || !newUsr) throw new Error("Bad impersonate response");
      // Stash the original token+user so we can Stop impersonating.
      const prevTok = localStorage.getItem("axiom_token");
      const prevUsr = localStorage.getItem("axiom_user");
      if (prevTok) localStorage.setItem("axiom_impersonate_prev_token", prevTok);
      if (prevUsr) localStorage.setItem("axiom_impersonate_prev_user", prevUsr);
      localStorage.setItem("axiom_impersonate_target", JSON.stringify({ name: newUsr.name, email: newUsr.email, enterprise_name: ent.name }));
      localStorage.setItem("axiom_token", newTok);
      localStorage.setItem("axiom_user", JSON.stringify(newUsr));
      // Clear the previously-selected company so the impersonated user's
      // own company-switcher default kicks in.
      localStorage.removeItem("axiom_company_id");
      toast.success(`Signing in as ${newUsr.name}…`);
      // Full reload → new token is picked up by every axios request +
      // the top-level Auth provider re-hydrates from localStorage.
      window.location.href = "/dashboard";
    } catch (e) {
      toast.error(e.response?.data?.detail || "Impersonation failed");
    }
  };
  const [showOnlyAction, setShowOnlyAction] = useState(false);
  const [resending, setResending] = useState({});
  const { switchCompany, refresh } = useCompany();
  const { user } = useAuth();
  const isSuperadmin = user?.role === "superadmin";

  // Superadmin-only view toggle. `clients` = default portfolio view.
  // `enterprise` = list of every accounting-firm ENTERPRISE on the
  // platform (each card is clickable and drills into the enterprise
  // detail page with a companies list-report + KPIs).
  const [mode, setMode] = useState("clients");
  const [enterprises, setEnterprises] = useState([]);
  const [entLoading, setEntLoading] = useState(false);

  // Search + layout toggle for the client portfolio. `q` matches on
  // company name, business type, owner name, and owner email — cheap
  // client-side filter that scales fine for the hundreds-of-clients
  // range a typical Pro portfolio hits. `layout` picks the card grid
  // (default, richer visual scannability) vs a compact list view
  // (fits ~3x more clients on screen for quick keyboard scanning).
  const [q, setQ] = useState("");
  const [layout, setLayout] = useState(() => localStorage.getItem("axiom_clients_layout") || "grid");
  useEffect(() => { try { localStorage.setItem("axiom_clients_layout", layout); } catch { /* quota */ } }, [layout]);

  const resendWelcome = async (cid, name) => {
    if (resending[cid]) return;
    setResending(prev => ({ ...prev, [cid]: true }));
    try {
      const r = await api.post(`/pro/clients/${cid}/resend-welcome`);
      const suffix = r.data.included_payment_link
        ? " The email includes a fresh Pay & activate link."
        : "";
      toast.success(
        `Sent — ${name}'s owner will get a fresh welcome email at ${r.data.sent_to}.${suffix}`,
        { duration: 6000 }
      );
    } catch (e) {
      const detail = e.response?.data?.detail || "Couldn't re-send the invite.";
      if (e.response?.status === 409) toast.info(detail);
      else toast.error(detail);
    } finally {
      setResending(prev => ({ ...prev, [cid]: false }));
    }
  };

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

  // Enterprise view — one-shot fetch (superadmin only). The backend
  // returns one row per Enterprise with pre-computed roll-up KPIs
  // (pros_count, clients_count, companies_count, free_used, free_remaining).
  const loadEnterprises = async () => {
    if (!isSuperadmin) return;
    setEntLoading(true);
    try {
      const r = await api.get("/admin/enterprises");
      setEnterprises(r.data?.enterprises || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load enterprises");
    } finally {
      setEntLoading(false);
    }
  };
  useEffect(() => {
    if (!isSuperadmin || mode !== "enterprise" || enterprises.length) return;
    loadEnterprises();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isSuperadmin]);

  // Sort by urgency so the most-in-need client bubbles to the top-left.
  // Primary: action_count desc (badge counts across flags, recons, invoices, bills).
  // Secondary: onboarding_complete false first (still-onboarding needs help),
  // Tertiary: flagged/needs_review desc, then name asc for stable ordering.
  const sorted = [...clients].sort((a, b) => {
    const aAct = a.action_count || 0;
    const bAct = b.action_count || 0;
    if (aAct !== bAct) return bAct - aAct;
    const aOnb = a.onboarding_complete ? 1 : 0;
    const bOnb = b.onboarding_complete ? 1 : 0;
    if (aOnb !== bOnb) return aOnb - bOnb;
    const aFlag = a.needs_review || a.flagged_count || 0;
    const bFlag = b.needs_review || b.flagged_count || 0;
    if (aFlag !== bFlag) return bFlag - aFlag;
    return (a.name || "").localeCompare(b.name || "");
  });
  const visible = (() => {
    const base = showOnlyAction ? sorted.filter(c => (c.action_count || 0) > 0) : sorted;
    const needle = q.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((c) => {
      const hay = [
        c.name, c.business_type, c.owner_name, c.owner_email,
      ].filter(Boolean).map((s) => s.toLowerCase()).join(" ");
      return hay.includes(needle);
    });
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            {mode === "enterprise" ? "Enterprises" : "My Clients"}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {mode === "enterprise"
              ? "Every accounting-firm parent on the platform. Click one to drill into its KPIs and companies."
              : "Firm portfolio · onboarding status · transactions needing your call."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperadmin && (
            <div className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5" data-testid="pro-clients-view-toggle">
              <button
                onClick={() => setMode("clients")}
                data-testid="pro-clients-view-clients"
                className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                  mode === "clients" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                Clients
              </button>
              <button
                onClick={() => setMode("enterprise")}
                data-testid="pro-clients-view-enterprise"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
                  mode === "enterprise" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Shield size={11} /> Enterprises
              </button>
            </div>
          )}
          {mode === "clients" && (
            <button
              data-testid="new-client-btn"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-slate-900 text-white text-sm"
            >
              <UserPlus size={14} /> New Client
            </button>
          )}
          {mode === "enterprise" && isSuperadmin && (
            <button
              data-testid="new-enterprise-btn"
              onClick={() => setCreatingEnterprise(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm"
            >
              <Shield size={14} /> Add Enterprise
            </button>
          )}
        </div>
      </div>

      {mode === "enterprise" ? (
        <EnterprisesGrid enterprises={enterprises} loading={entLoading} onOpenAsOwner={openAsOwner} />
      ) : (
      <>
      <FirmAttentionTile
        firm={firm}
        showOnlyAction={showOnlyAction}
        onToggle={() => setShowOnlyAction(v => !v)}
      />

      {/* Search + view-toggle row. Search filters on company name,
          business type, owner name, and owner email — everything a
          Pro would type when hunting for a specific client. Layout
          toggle picks between the rich card grid (default) and a
          compact list view better suited for keyboard-scanning
          large portfolios. Preference is remembered per browser. */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-xl">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clients — company name, owner name, owner email…"
            data-testid="pro-clients-search"
            className="w-full pl-9 pr-8 py-2 rounded-md border border-slate-200 bg-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
              title="Clear search"
              data-testid="pro-clients-search-clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5" data-testid="pro-clients-layout-toggle">
          <button
            onClick={() => setLayout("grid")}
            data-testid="pro-clients-layout-grid"
            title="Card grid — richer visual per client"
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
              layout === "grid" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <LayoutGrid size={12} /> Grid
          </button>
          <button
            onClick={() => setLayout("list")}
            data-testid="pro-clients-layout-list"
            title="Compact list — more clients per screen"
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
              layout === "list" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <ListIcon size={12} /> List
          </button>
        </div>
        <div className="text-xs text-slate-500 ml-auto tabular-nums" data-testid="pro-clients-count">
          {visible.length} of {clients.length}
        </div>
      </div>

      {layout === "list" && (
        <ClientsList
          visible={visible}
          onOpen={(cid) => { switchCompany(cid); window.location.href = "/dashboard"; }}
          onResend={resendWelcome}
          resending={resending}
        />
      )}

      {layout === "grid" && (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(c => {
          const act = c.action_count || 0;
          const isReady = act === 0 && c.onboarding_complete;
          return (
            <div
              key={c.id}
              className={`rounded-xl border bg-white p-4 hover:border-slate-400 transition flex flex-col ${
                act > 0
                  ? "border-amber-300"
                  : isReady
                    ? "border-emerald-300 ring-1 ring-emerald-200"
                    : ""
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
                  {c.needs_activation && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800 flex items-center gap-1"
                      title="Client hasn't paid yet — resend the Pay & activate link"
                      data-testid={`needs-activation-badge-${c.id}`}
                    >
                      <CreditCard size={10} /> Awaiting payment
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
              {/* flex-1 middle: pushes the Open books button to the bottom
                  so every card ends at the same y-coordinate regardless of
                  whether it has an action summary. */}
              <div className="flex-1">
                {act > 0 && <ClientActionSummary c={c} />}
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                <button
                  onClick={() => { switchCompany(c.id); window.location.href = "/dashboard"; }}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
                  data-testid={`open-books-${c.id}`}
                >
                  Open books <ArrowRight size={12} />
                </button>
                <button
                  onClick={() => resendWelcome(c.id, c.name)}
                  disabled={resending[c.id]}
                  data-testid={`resend-welcome-${c.id}`}
                  title={c.needs_activation
                    ? "Re-send the client's Pay & activate email"
                    : "Re-send the client's welcome email"}
                  className={`inline-flex items-center justify-center w-8 h-[30px] rounded-md border disabled:opacity-50 ${
                    c.needs_activation
                      ? "border-cyan-300 text-cyan-700 bg-cyan-50 hover:bg-cyan-100"
                      : "border-slate-200 text-slate-500 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50"
                  }`}
                >
                  {resending[c.id] ? <Loader2 size={12} className="animate-spin" /> : <MailPlus size={12} />}
                </button>
              </div>
            </div>
          );
        })}
        {!visible.length && layout === "grid" && (
          <div className="col-span-full text-sm text-slate-500 border border-dashed rounded-xl p-8 text-center">
            {q.trim()
              ? <>No clients match <b className="text-slate-700">"{q}"</b>. Try a different name, email, or business type.</>
              : showOnlyAction
                ? "All clients are clear. Nothing needs your attention today."
                : "No clients yet. Click \"New Client\" to add your first one."}
          </div>
        )}
      </div>
      )}
      {!visible.length && layout === "list" && (
        <div className="text-sm text-slate-500 border border-dashed rounded-xl p-8 text-center">
          {q.trim()
            ? <>No clients match <b className="text-slate-700">"{q}"</b>. Try a different name, email, or business type.</>
            : showOnlyAction
              ? "All clients are clear. Nothing needs your attention today."
              : "No clients yet. Click \"New Client\" to add your first one."}
        </div>
      )}

      {creating && <NewClientModal onClose={() => setCreating(false)} onCreated={async () => { await load(); await refresh(); setCreating(false); }} />}
      </>
      )}
      {/* Enterprise-create modal lives OUTSIDE the mode ternary so it
          renders on either tab (the "Add Enterprise" button lives on
          the Enterprises tab, but we hoist the modal here so it can
          survive a tab switch mid-edit). */}
      {creatingEnterprise && (
        <NewEnterpriseModal
          onClose={() => setCreatingEnterprise(false)}
          onCreated={async () => {
            await loadEnterprises();
            setCreatingEnterprise(false);
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// ClientsList — compact list/table view of the client portfolio.
// Same data model as the card grid; renders as one row per client with
// scannable columns (Company, Owner, Business type, Txns, Review,
// Status pills). "Open books" and "Resend welcome" actions live on the
// right so keyboard-driven users can zip through clients quickly.
// Preserves the "Awaiting payment" and Ready/Onboarding pills so the
// two views surface the same signals.
// --------------------------------------------------------------------------
function ClientsList({ visible, onOpen, onResend, resending }) {
  if (!visible.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="pro-clients-list">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Company</th>
            <th className="text-left px-4 py-2 font-medium">Owner</th>
            <th className="text-left px-4 py-2 font-medium">Type</th>
            <th className="text-right px-4 py-2 font-medium">Txns</th>
            <th className="text-right px-4 py-2 font-medium">Review</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-right px-4 py-2 font-medium">&nbsp;</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visible.map((c) => {
            const act = c.action_count || 0;
            return (
              <tr key={c.id} className="hover:bg-slate-50 transition" data-testid={`pro-clients-list-row-${c.id}`}>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {c.name}
                    {act > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 inline-flex items-center gap-1">
                        <BellRing size={9} /> {act}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-slate-600">
                  <div className="text-slate-800">{c.owner_name || "—"}</div>
                  <div className="text-[11px] text-slate-400">{c.owner_email || ""}</div>
                </td>
                <td className="px-4 py-2 text-slate-500 truncate max-w-[180px]">{c.business_type || "—"}</td>
                <td className="px-4 py-2 text-right font-mono-num text-slate-700">{c.transactions ?? 0}</td>
                <td className={`px-4 py-2 text-right font-mono-num ${(c.needs_review ?? 0) > 0 ? "text-orange-700" : "text-slate-400"}`}>
                  {c.needs_review ?? 0}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {c.needs_activation && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800 inline-flex items-center gap-1">
                        <CreditCard size={9} /> Awaiting payment
                      </span>
                    )}
                    {c.onboarding_complete
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={9} /> Ready</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Onboarding</span>}
                  </div>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-1">
                    <button
                      onClick={() => onOpen(c.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 text-white text-xs"
                      data-testid={`open-books-list-${c.id}`}
                    >
                      Open <ArrowRight size={11} />
                    </button>
                    <button
                      onClick={() => onResend(c.id, c.name)}
                      disabled={resending[c.id]}
                      title={c.needs_activation ? "Re-send Pay & activate email" : "Re-send welcome email"}
                      data-testid={`resend-welcome-list-${c.id}`}
                      className={`inline-flex items-center justify-center w-7 h-7 rounded border disabled:opacity-50 ${
                        c.needs_activation
                          ? "border-cyan-300 text-cyan-700 bg-cyan-50 hover:bg-cyan-100"
                          : "border-slate-200 text-slate-500 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50"
                      }`}
                    >
                      {resending[c.id] ? <Loader2 size={11} className="animate-spin" /> : <MailPlus size={11} />}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}



// --------------------------------------------------------------------------
// EnterprisesGrid — SUPERADMIN-ONLY view of every Enterprise on the
// platform. Cards are deliberately styled distinctly from client cards
// (indigo→violet→fuchsia gradient border + Shield icon) so a superadmin
// can tell at a glance which portfolio they're looking at. Clicking a
// card opens /admin/enterprises/{eid} — the detail page with KPI row
// and companies list report.
// --------------------------------------------------------------------------
function EnterprisesGrid({ enterprises, loading, onOpenAsOwner }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-slate-500 flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading enterprises…
      </div>
    );
  }
  if (!enterprises.length) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-slate-500">
        No enterprises on the platform yet.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="enterprises-grid">
      {enterprises.map((e) => (
        <Link
          key={e.id}
          to={`/admin/enterprises/${e.id}`}
          data-testid={`enterprise-card-${e.id}`}
          className="group relative rounded-xl p-[1.5px] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-[10px] bg-white p-4 h-full flex flex-col">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex-shrink-0">
                    <Shield size={13} />
                  </span>
                  <div className="font-heading font-semibold text-lg truncate">
                    {e.name}
                  </div>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">
                  slug: <span className="font-mono-num">{e.slug}</span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                {e.is_default && (
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-medium">
                    Default
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
                  Enterprise
                </span>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="rounded-md bg-indigo-50/60 p-2">
                <div className="text-[10px] uppercase text-indigo-700 flex items-center gap-1">
                  <Users2 size={10} /> Pros
                </div>
                <div className="font-mono-num font-semibold text-indigo-800">{e.pros_count}</div>
              </div>
              <div className="rounded-md bg-cyan-50/60 p-2">
                <div className="text-[10px] uppercase text-cyan-700 flex items-center gap-1">
                  <Ticket size={10} /> Clients
                </div>
                <div className="font-mono-num font-semibold text-cyan-800">{e.clients_count}</div>
              </div>
              <div className="rounded-md bg-violet-50/60 p-2">
                <div className="text-[10px] uppercase text-violet-700 flex items-center gap-1">
                  <Building2 size={10} /> Cos
                </div>
                <div className="font-mono-num font-semibold text-violet-800">{e.companies_count}</div>
              </div>
            </div>

            <div className="mt-3 flex-1 text-[11px] text-slate-600 space-y-1">
              <div className="flex items-center gap-1.5">
                <Gift size={11} className="text-emerald-500" />
                <span className="text-slate-500">Free spots:</span>
                <span className="font-mono-num text-slate-700">
                  {e.free_used} / {e.free_user_allotment}
                </span>
                <span className="text-slate-400 ml-auto">({e.free_remaining} left)</span>
              </div>
              <div className="text-[10px] text-slate-400">
                Default product: {e.default_product}{e.default_discount ? " · discount" : ""}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 group-hover:text-indigo-900">
                Open enterprise <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
              </div>
              {e.owner_user_id && (
                <button
                  data-testid={`enterprise-open-as-owner-${e.id}`}
                  onClick={(evt) => {
                    // Cancel the enclosing <Link> navigation so we
                    // impersonate INSTEAD of drilling into the admin
                    // enterprise detail page.
                    evt.preventDefault();
                    evt.stopPropagation();
                    onOpenAsOwner && onOpenAsOwner(e);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium shadow-sm"
                  title="Sign in as the enterprise owner"
                >
                  Open <ArrowRight size={11} />
                </button>
              )}
            </div>
          </div>
        </Link>
      ))}
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

// --------------------------------------------------------------------------
// BillingSection — payer / product / discount pickers on the New Client
// modal. Fed by the /pro/billing/context payload which carries the caller
// enterprise's remaining free spots + the price catalog.
// --------------------------------------------------------------------------
function BillingSection({ billing, form, update }) {
  const catalog = billing?.price_catalog || {};
  const ent = billing?.enterprise || null;
  const freeRemaining = ent ? Math.max(0, ent.free_remaining ?? 0) : 0;

  const product = form.billing_product || "simple_start";
  const catItem = catalog[product] || { regular: 0, discount: 0, label: product };
  const regularPrice = catItem.regular ?? 0;
  const discountPrice = catItem.discount ?? 0;
  const effectivePrice = form.billing_discount ? discountPrice : regularPrice;

  const payerOptions = [
    { value: "client_email", label: "Client — email bill",           hint: "We email the invoice; client pays directly" },
    { value: "client_card",  label: "Client — pay with client card", hint: "You'll enter the client's card in the next step" },
    { value: "enterprise",   label: "Enterprise pays",               hint: "Rolled into your firm's monthly invoice" },
    { value: "free_spot",    label: `Free enterprise spot (${freeRemaining} left)`, hint: "Comp'd — no charge posts", disabled: freeRemaining <= 0 },
  ];

  return (
    <div className="mt-3 pt-3 border-t space-y-3" data-testid="new-client-billing-section">
      <div className="text-xs uppercase tracking-wider text-slate-500 border-b pb-1">
        Billing
      </div>

      {ent && (
        <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-600 flex items-center gap-2">
          <Shield size={11} className="text-indigo-500 flex-shrink-0" />
          <span>
            You're billing under <b>{ent.name}</b>
            {ent.is_default ? "" : " (private label)"}
            {" · "}
            <span className="font-mono-num">{freeRemaining}</span> of {ent.free_user_allotment} free spots remaining
          </span>
        </div>
      )}

      {/* --- Who is paying --- */}
      <div>
        <label className="text-xs text-slate-600">Who is paying?</label>
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="new-client-payer-picker">
          {payerOptions.map((opt) => {
            const active = form.billing_payer === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => !opt.disabled && update("billing_payer", opt.value)}
                disabled={opt.disabled}
                data-testid={`new-client-payer-${opt.value}`}
                className={`text-left rounded-md border px-3 py-2 text-xs transition ${
                  active
                    ? "border-indigo-500 bg-indigo-50 text-indigo-900 ring-2 ring-indigo-200"
                    : opt.disabled
                      ? "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                      : "border-slate-200 hover:border-slate-400 hover:bg-slate-50 text-slate-700"
                }`}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{opt.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {form.billing_payer !== "free_spot" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-600">Product</label>
            <select
              value={product}
              onChange={(e) => update("billing_product", e.target.value)}
              data-testid="new-client-product-picker"
              className="w-full mt-1 border rounded px-2 py-1.5"
            >
              {Object.entries(catalog).map(([key, val]) => (
                <option key={key} value={key}>{val.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-600">Pricing</label>
            <label
              className="mt-1 flex items-center gap-2 border rounded px-2 py-1.5 cursor-pointer hover:bg-slate-50"
              data-testid="new-client-discount-toggle"
            >
              <input
                type="checkbox"
                checked={!!form.billing_discount}
                onChange={(e) => update("billing_discount", e.target.checked)}
              />
              <span className="text-xs">
                Apply discount ($<span className="font-mono-num">{discountPrice}</span>/mo
                <span className="text-slate-400"> vs $</span>
                <span className="font-mono-num line-through text-slate-400">{regularPrice}</span>)
              </span>
            </label>
          </div>
        </div>
      )}

      {/* Effective-price summary + payer-specific copy */}
      <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs" data-testid="new-client-billing-summary">
        {form.billing_payer === "free_spot" ? (
          <>
            <b className="text-violet-700">Free enterprise spot.</b>{" "}
            No charge will post. This spot is permanent for the life of the company.
          </>
        ) : form.billing_payer === "enterprise" ? (
          <>
            <b className="text-indigo-700">Enterprise will be billed on the 5th of next month</b>
            {" · "}${effectivePrice}/mo · {catItem.label}
            {form.billing_discount ? " · discounted" : ""}
          </>
        ) : form.billing_payer === "client_card" ? (
          <>
            <b className="text-cyan-700">You'll enter the client's card on the next screen.</b>
            {" · "}${effectivePrice}/mo · {catItem.label}
            {form.billing_discount ? " · discounted" : ""}
          </>
        ) : (
          <>
            <b className="text-slate-700">We'll email the client the bill.</b>
            {" · "}${effectivePrice}/mo · {catItem.label}
            {form.billing_discount ? " · discounted" : ""}
          </>
        )}
      </div>
    </div>
  );
}



function NewClientModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    company_name: "", business_type: "", business_description: "",
    client_name: "", client_email: "", client_password: "",
    reporting_basis: "accrual",
    // Phase B billing intent — populated once billing context lands.
    billing_payer: "client_email",
    billing_product: "simple_start",
    billing_discount: false,
  });
  const [busy, setBusy] = useState(false);
  const [existingEmail, setExistingEmail] = useState(false);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [billing, setBilling] = useState(null); // { enterprise, price_catalog, ... }
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // One-shot fetch of the caller's enterprise + product catalog so the
  // payer/product/discount pickers can render with real prices + remaining
  // free-spot count on modal open.
  useEffect(() => {
    let cancelled = false;
    api.get("/pro/billing/context")
      .then((r) => {
        if (cancelled) return;
        setBilling(r.data);
        const ent = r.data?.enterprise;
        if (ent) {
          // Pre-seed the pickers from the enterprise's defaults.
          setForm((f) => ({
            ...f,
            billing_product: ent.default_product || "simple_start",
            billing_discount: !!ent.default_discount,
          }));
        }
      })
      .catch(() => setBilling({ enterprise: null, price_catalog: {} }));
    return () => { cancelled = true; };
  }, []);

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
    setBusy(true);
    try {
      const r = await api.post("/pro/clients", form);
      const status = r.data.email_status;
      const err = r.data.email_error;
      const emailOk = status === "sent";
      const emailNote =
        status === "sent" ? "we've emailed them the good news."
        : status === "skipped_pref_off" ? "email skipped — your welcome-email preference is off. Toggle it back on under Settings → Notifications if you meant to send."
        : status === "skipped_no_email" ? "no email on file, so nothing was sent."
        : `email FAILED to send${err ? ` (${err.slice(0,140)})` : ""} — check Communications for details.`;
      if (r.data.reused_existing_user) {
        (emailOk ? toast.success : toast.error)(
          `${form.company_name} added to ${form.client_email}'s existing login. They now own ${r.data.owner_company_count} companies — ${emailNote}`,
          { duration: emailOk ? 7000 : 12000 },
        );
      } else {
        (emailOk ? toast.success : toast.error)(
          `Client "${form.client_name}" created — ${emailNote.replace(/^we've emailed them the good news\.$/, `they'll get a "Set your password" email at ${form.client_email}.`)}`,
          { duration: emailOk ? 7000 : 12000 },
        );
      }
      // Phase C — if the accountant chose to enter the client's card
      // right now, redirect to Stripe Checkout with the freshly-created
      // company as the target. On successful payment Stripe redirects
      // to /billing/success which flips billing_state to `active` and
      // dismisses the blocking modal. Skipped for email/enterprise/
      // free_spot payers.
      //
      // CRITICAL UX: the client + company ARE ALREADY CREATED at this
      // point. If Stripe checkout fails (missing env, invalid key, etc.)
      // we must not leave the pro thinking the whole flow crashed —
      // the error toast has to make it obvious the client was saved and
      // only the payment redirect was lost.
      if (form.billing_payer === "client_card" && r.data.company_id) {
        try {
          const co = await api.post(
            `/companies/${r.data.company_id}/billing/checkout-session`,
            { origin_url: window.location.origin },
          );
          if (co.data?.checkout_url) {
            window.location.href = co.data.checkout_url;
            return;
          }
        } catch (e) {
          const detail = e.response?.data?.detail || "";
          toast.error(
            <div>
              <b>{form.company_name} was created ✓</b> — but Stripe checkout couldn't open.
              <div className="mt-1 text-[11px] opacity-90">{detail}</div>
              <div className="mt-2 text-[11px]">
                The company will show a <b>billing-locked modal</b> on next open with a
                Pay-now button — nothing is lost. Ask a superadmin to fix the missing
                Stripe env var and the "Pay now" button will work.
              </div>
            </div>,
            { duration: 20_000 },
          );
        }
      }
      onCreated();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create client");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
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
          <div>
            <label className="text-xs text-slate-600">Email</label>
            <input data-testid="new-client-email" type="email" value={form.client_email}
                   onChange={(e) => update("client_email", e.target.value)}
                   className={`w-full mt-1 border rounded px-2 py-1.5 ${existingEmail ? "border-cyan-400 bg-cyan-50/40" : ""}`} />
            {checkingEmail && <div className="text-[10px] text-slate-400 mt-1">Checking…</div>}
            {existingEmail && !checkingEmail && (
              <div className="text-[11px] text-cyan-700 mt-1" data-testid="new-client-email-reuse-hint">
                ✓ Existing client login — this new company will be added to their dropdown, and we'll email them the good news.
              </div>
            )}
          </div>
          <div className="text-[11px] text-slate-500">
            {existingEmail
              ? "This client already has a login. They'll see the new company in the top-left dropdown after their next sign-in."
              : (<>A GAAP-compliant Chart of Accounts is seeded automatically. We'll email <b>{form.client_email || "the client"}</b> a "Set your password" link — no need to share a temporary password.</>)}
          </div>

          {/* -------------------- Billing (Phase B) --------------------
              Payer + product + discount pickers. The "Free Enterprise
              Spot" option only appears when the enterprise still has
              capacity. When Enterprise pays, we surface the 5th-of-
              next-month billing copy so the pro sets the client's
              expectation up-front.                                         */}
          <BillingSection billing={billing} form={form} update={update} />
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


// -----------------------------------------------------------------------------
// NewEnterpriseModal — Superadmin-only. Lets the admin mint a fresh
// Enterprise record from the Enterprises grid header. Slug auto-fills
// from `name` (kebab-cased) but is editable in case the user wants to
// pin a specific URL/subdomain. `owner_user_id` is intentionally omitted
// from this quick-create UI — most manually-spawned enterprises start
// unassigned and get a Pro attached later from the detail page.
// -----------------------------------------------------------------------------
function NewEnterpriseModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [freeSpots, setFreeSpots] = useState(0);
  const [defaultProduct, setDefaultProduct] = useState("simple_start");
  const [defaultDiscount, setDefaultDiscount] = useState(false);
  const [busy, setBusy] = useState(false);

  const slugify = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effectiveSlug = slug.trim() || slugify(name);
  // Basic client-side email sanity — server does the authoritative check.
  const ownerEmailValid = !ownerEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim());

  const save = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (ownerEmail.trim() && !ownerEmailValid) { toast.error("Owner email looks invalid"); return; }
    if (ownerEmail.trim() && !ownerName.trim()) { toast.error("Owner name is required when you supply an email"); return; }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        slug: effectiveSlug || undefined,
        free_user_allotment: Number(freeSpots) || 0,
        default_product: defaultProduct,
        default_discount: defaultDiscount,
      };
      if (ownerEmail.trim()) {
        payload.owner_email = ownerEmail.trim();
        payload.owner_name = ownerName.trim();
      }
      const r = await api.post("/admin/enterprises", payload);
      const emailStatus = r.data?.email_status;
      const ownerProvisioned = r.data?.owner_provisioned;
      if (ownerProvisioned && emailStatus === "sent") {
        toast.success(`Enterprise created — magic-link login sent to ${ownerEmail.trim()}`);
      } else if (ownerProvisioned) {
        toast.success(`Enterprise created — owner account provisioned (email dispatch: ${emailStatus || "unknown"})`);
      } else {
        toast.success(`Enterprise "${name.trim()}" created`);
      }
      onCreated && onCreated();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not create enterprise");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" data-testid="new-enterprise-modal">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b flex items-center justify-between bg-gradient-to-r from-indigo-50 to-violet-50">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-indigo-600" />
            <div className="font-heading font-semibold text-lg">Add Enterprise</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/60 text-slate-500" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Enterprise name</label>
            <input
              autoFocus
              data-testid="new-enterprise-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Capstone Books"
              className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Slug <span className="font-normal text-slate-400">(URL / subdomain — auto-fills)</span>
            </label>
            <input
              data-testid="new-enterprise-slug"
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={slugify(name) || "capstone-books"}
              className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
            />
            {!slug.trim() && name.trim() && (
              <div className="text-[11px] text-slate-500 mt-1">
                Will use <span className="font-mono">{effectiveSlug}</span>
              </div>
            )}
          </div>
          {/* Owner block — optional. If both name and email are supplied
              the backend creates (or attaches) a Pro user and emails
              them a magic-link set-password URL so they can log in and
              take over the account. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2.5">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Owner (Pro user)
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full name</label>
                <input
                  data-testid="new-enterprise-owner-name"
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="e.g. Priya Patel"
                  className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Login email</label>
                <input
                  data-testid="new-enterprise-owner-email"
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="priya@capstonebooks.com"
                  className={`w-full px-3 py-2 rounded-md border text-sm focus:ring-1 outline-none bg-white ${ownerEmailValid ? "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500" : "border-rose-400 focus:border-rose-500 focus:ring-rose-500"}`}
                />
              </div>
            </div>
            <div className="text-[11px] text-slate-500 leading-snug">
              Leave blank to create an unassigned enterprise. If you fill both, we'll create the Pro account and email a magic-link so they can set their password.
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Default product</label>
              <select
                data-testid="new-enterprise-product"
                value={defaultProduct}
                onChange={(e) => setDefaultProduct(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white"
              >
                <option value="simple_start">Simple Start</option>
                <option value="essentials">Essentials</option>
                <option value="plus">Plus</option>
                <option value="advanced">Advanced</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Free spots</label>
              <input
                data-testid="new-enterprise-free-spots"
                type="number"
                min="0"
                max="10000"
                value={freeSpots}
                onChange={(e) => setFreeSpots(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              data-testid="new-enterprise-discount"
              type="checkbox"
              checked={defaultDiscount}
              onChange={(e) => setDefaultDiscount(e.target.checked)}
              className="rounded border-slate-300"
            />
            Apply default discount to new companies under this enterprise
          </label>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2 bg-slate-50">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm">Cancel</button>
          <button
            data-testid="new-enterprise-save"
            onClick={save}
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-60"
          >
            {busy && <Loader2 size={13} className="animate-spin" />} Create enterprise
          </button>
        </div>
      </div>
    </div>
  );
}
