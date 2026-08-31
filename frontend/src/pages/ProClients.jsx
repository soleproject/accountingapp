import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { BUSINESS_TYPES } from "@/constants/businessTypes";
import {
  AlertTriangle, CheckCircle2, ArrowRight, Plus, X, Loader2, UserPlus,
  BellRing, Wand2, FileText as FileWarning, FileText as ReceiptText, ScrollText, Sparkles, MailPlus,
  Building2, Shield, Users2, Palette, Link as LinkIcon, Gift, Ticket, CreditCard,
  Search, LayoutGrid, List as ListIcon, Users as Handshake, ExternalLink, BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import { CreatePartnerModal } from "@/components/PartnersCard";
import { useFeatureFlag } from "@/lib/featureFlags";
import { REGIONS } from "@/lib/regions";

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
  const { switchCompany, refresh, companies } = useCompany();
  const navigate = useNavigate();
  // Firm Books company for this pro — surfaced as its own tile above
  // the client list so partners can jump into their firm's own books
  // in one click, instead of hunting through the company switcher.
  const firmBooks = (companies || []).find((c) => c.is_firm_books === true);
  const { user } = useAuth();
  const isSuperadmin = user?.role === "superadmin";

  // Superadmin-only view toggle. Persisted in localStorage so that
  // clicking "back to Partners" (or Enterprises) from a detail page
  // returns to the same mode instead of resetting to Clients
  // (Round 7.19, Feb 2026).
  //
  // Guardrail (Feb 2026 Round 8.1): the localStorage key is scoped
  // to the browser, not the user. When the same browser is used to
  // log in as a superadmin (who saved `enterprise` / `partners`) and
  // then re-login as a Pro (who is not allowed to see those views),
  // the persisted value would leak the empty superadmin scope into
  // the Pro session. Clamp non-superadmin roles to `clients` on
  // every mount so the toggle can never leave a Pro stranded on a
  // view whose toggle button is hidden from them.
  const [mode, setMode] = useState(() => {
    try {
      const saved = localStorage.getItem("axiom_pro_clients_mode");
      const okForSuperadmin = saved === "clients" || saved === "enterprise" || saved === "partners";
      const isSuper = user?.role === "superadmin";
      if (isSuper && okForSuperadmin) return saved;
      // Non-superadmin: only "clients" is legal.
      if (!isSuper) return "clients";
    } catch { /* quota */ }
    return "clients";
  });
  // Belt-and-braces: if the user object flips to a non-superadmin at
  // any point during the session (e.g. impersonation ends), snap
  // back to `clients` so the UI can't be stuck on an empty
  // enterprise/partners view whose toggle isn't rendered for them.
  useEffect(() => {
    if (user && user.role !== "superadmin" && mode !== "clients") {
      setMode("clients");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role]);
  useEffect(() => {
    try { localStorage.setItem("axiom_pro_clients_mode", mode); } catch { /* quota */ }
  }, [mode]);
  const [enterprises, setEnterprises] = useState([]);
  const [entLoading, setEntLoading] = useState(false);
  const [partners, setPartners] = useState([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [creatingPartner, setCreatingPartner] = useState(false);

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
    if (!isSuperadmin || enterprises.length) return;
    loadEnterprises();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperadmin]);

  // Partners view — same superadmin-only gate as enterprises. Rollup
  // stats (clients, enterprises, users, has_partner_books) are
  // computed on the backend so the grid is one cheap fetch.
  const loadPartners = async () => {
    if (!isSuperadmin) return;
    setPartnersLoading(true);
    try {
      const r = await api.get("/superadmin/partners");
      setPartners(r.data?.partners || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load partners");
    } finally {
      setPartnersLoading(false);
    }
  };
  useEffect(() => {
    if (!isSuperadmin || partners.length) return;
    loadPartners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperadmin]);

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
            {mode === "enterprise" ? "Enterprises" : mode === "partners" ? "Partners" : "My Clients"}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {mode === "enterprise"
              ? "Every accounting-firm parent on the platform. Click one to drill into its KPIs and companies."
              : mode === "partners"
              ? "Resellers who provision their own enterprises + clients. Each Partner sees usage, costs, and revenue scoped only to their tree."
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
              <button
                onClick={() => setMode("partners")}
                data-testid="pro-clients-view-partners"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
                  mode === "partners" ? "bg-orange-600 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Handshake size={11} /> Partners
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
          {mode === "partners" && isSuperadmin && (
            <button
              data-testid="new-partner-btn"
              onClick={() => setCreatingPartner(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm"
            >
              <Handshake size={14} /> New Partner
            </button>
          )}
        </div>
      </div>

      {/* Superadmin platform KPIs — Round 7.14 (Feb 2026). Three
          tinted cards at the top of the Clients page counting every
          Partner, Enterprise, and Client on the platform. Clicking a
          card flips the mode-toggle so a superadmin can drill in
          without hunting for the pill. */}
      {isSuperadmin && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4"
              data-testid="superadmin-kpi-row">
          <SuperadminKpi
            label="Partners" value={partners.length} icon={Handshake}
            tone="orange" onClick={() => setMode("partners")}
            testid="superadmin-kpi-partners"
          />
          <SuperadminKpi
            label="Enterprises" value={enterprises.length} icon={Shield}
            tone="indigo" onClick={() => setMode("enterprise")}
            testid="superadmin-kpi-enterprises"
          />
          <SuperadminKpi
            label="Clients" value={clients.length} icon={Building2}
            tone="cyan" onClick={() => setMode("clients")}
            testid="superadmin-kpi-clients"
          />
        </div>
      )}

      {mode === "enterprise" ? (
        <>
          <div className="flex justify-end">
            <LayoutToggle
              layout={layout} setLayout={setLayout}
              testid="pro-enterprises-layout-toggle"
            />
          </div>
          <EnterprisesGrid
            enterprises={enterprises} loading={entLoading}
            onOpenAsOwner={openAsOwner} layout={layout}
          />
        </>
      ) : mode === "partners" ? (
        <>
          <div className="flex justify-end">
            <LayoutToggle
              layout={layout} setLayout={setLayout}
              testid="pro-partners-layout-toggle"
            />
          </div>
          <PartnersGrid
            partners={partners} loading={partnersLoading}
            layout={layout}
          />
        </>
      ) : (
      <>
      {/* Firm Books tile — a one-click jump into the pro's OWN books.
          Sits above the client-attention tile so partners don't have
          to open the company switcher to work on their firm's own
          accounting. Skipped silently if the pro somehow doesn't have
          a firm-books company yet (the boot-time backfill in
          `enterprises.ensure_default_enterprise` provisions one for
          every pro, so this is defensive). Also hidden for
          superadmins — they don't own client firm books
          (Round 7.13, Feb 2026). */}
      {firmBooks && !isSuperadmin && (
        <button
          data-testid="firm-books-tile"
          onClick={async () => {
            await switchCompany(firmBooks.id);
            navigate("/dashboard");
          }}
          className="w-full text-left rounded-xl border-2 border-cyan-200 bg-gradient-to-r from-cyan-50 to-white hover:from-cyan-100 hover:to-cyan-50 transition p-5 flex items-center justify-between gap-4 group"
        >
          <div className="flex items-center gap-4 min-w-0">
            <div className="rounded-lg bg-cyan-500 text-white p-3 flex-shrink-0">
              <Building2 size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest font-semibold text-cyan-700">
                Your Firm
              </div>
              <div className="font-heading font-bold text-lg text-slate-900 truncate">
                {firmBooks.name}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Your firm's own accounting books · click to open
              </div>
            </div>
          </div>
          <div className="text-xs text-cyan-700 font-semibold uppercase tracking-widest flex-shrink-0 opacity-0 group-hover:opacity-100 transition">
            Open →
          </div>
        </button>
      )}
      {/* Superadmin ops don't own client action queues, so the
          "N of M clients need action today" attention tile is only
          shown to firm Pros / partner admins (Round 7.13, Feb 2026). */}
      {!isSuperadmin && (
        <FirmAttentionTile
          firm={firm}
          showOnlyAction={showOnlyAction}
          onToggle={() => setShowOnlyAction(v => !v)}
        />
      )}

      <InsightsCostAlertTile onOpenClient={(cid) => switchCompany(cid)} />

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
                  ? "border-cyan-200 ring-1 ring-cyan-100"
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
                <div className="rounded-md bg-cyan-50 p-2">
                  <div className="text-[10px] uppercase text-cyan-700 flex items-center gap-1"><AlertTriangle size={10} /> Review</div>
                  <div className="font-mono-num font-semibold text-cyan-700">{c.needs_review ?? c.flagged_count ?? 0}</div>
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

      {creating && <NewClientModal onClose={() => setCreating(false)} onCreated={async (newCid) => { await load(); await refresh(); if (newCid) switchCompany(newCid); setCreating(false); }} />}
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
      {/* Partner-create modal — same hoisting rationale as the
          enterprise one above. Reuses the CreatePartnerModal from the
          PartnersCard component so the "New Partner" experience is
          identical between the toggle grid and any future entry
          point. */}
      {creatingPartner && (
        <CreatePartnerModal
          onClose={() => setCreatingPartner(false)}
          onCreated={async () => {
            await loadPartners();
            setCreatingPartner(false);
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
                <td className={`px-4 py-2 text-right font-mono-num ${(c.needs_review ?? 0) > 0 ? "text-cyan-700" : "text-slate-400"}`}>
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



// LayoutToggle — shared Grid/List switcher used by all three
// superadmin views (Clients, Enterprises, Partners) so a user's
// preferred layout is consistent across the mode toggle
// (Round 7.15, Feb 2026).
function LayoutToggle({ layout, setLayout, testid }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5"
          data-testid={testid}>
      <button
        onClick={() => setLayout("grid")}
        data-testid={`${testid}-grid`}
        title="Card grid — richer per row"
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
          layout === "grid" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
        }`}
      >
        <LayoutGrid size={12} /> Grid
      </button>
      <button
        onClick={() => setLayout("list")}
        data-testid={`${testid}-list`}
        title="Compact list — more rows per screen"
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition ${
          layout === "list" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
        }`}
      >
        <ListIcon size={12} /> List
      </button>
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
function EnterprisesGrid({ enterprises, loading, onOpenAsOwner, layout = "grid" }) {
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
  if (layout === "list") {
    return (
      <div className="rounded-xl border border-slate-200 overflow-hidden bg-white"
            data-testid="enterprises-list">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[10px] uppercase tracking-widest text-slate-500">
              <th className="px-4 py-2">Enterprise</th>
              <th className="px-4 py-2">Slug</th>
              <th className="px-4 py-2 text-right">Pros</th>
              <th className="px-4 py-2 text-right">Clients</th>
              <th className="px-4 py-2 text-right">Cos</th>
              <th className="px-4 py-2 text-right">Free spots</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {enterprises.map(e => (
              <tr key={e.id} className="hover:bg-slate-50"
                  data-testid={`enterprise-row-${e.id}`}>
                <td className="px-4 py-2">
                  <Link to={`/admin/enterprises/${e.id}`}
                        className="inline-flex items-center gap-2 font-semibold text-slate-900 hover:text-indigo-700">
                    <Shield size={13} className="text-indigo-600" />
                    {e.name}
                    {e.is_default && (
                      <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        Default
                      </span>
                    )}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500 font-mono-num text-xs">{e.slug}</td>
                <td className="px-4 py-2 text-right font-mono-num text-indigo-700">{e.pros_count}</td>
                <td className="px-4 py-2 text-right font-mono-num text-cyan-700">{e.clients_count}</td>
                <td className="px-4 py-2 text-right font-mono-num text-violet-700">{e.companies_count}</td>
                <td className="px-4 py-2 text-right font-mono-num text-slate-600">
                  {e.free_used} / {e.free_user_allotment}
                  <span className="text-slate-400 ml-1">({e.free_remaining} left)</span>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {e.owner_user_id && (
                    <button
                      onClick={() => onOpenAsOwner && onOpenAsOwner(e)}
                      data-testid={`enterprise-open-as-owner-row-${e.id}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-medium mr-1"
                    >
                      Open <ArrowRight size={10} />
                    </button>
                  )}
                  <Link to={`/admin/enterprises/${e.id}`}
                        className="text-indigo-700 hover:text-indigo-900 text-[11px] font-medium">
                    Details →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

// --------------------------------------------------------------------------
// PartnersGrid — SUPERADMIN-ONLY view of every Partner (reseller) on
// the platform. Fuchsia gradient border + Handshake icon so it reads
// visually distinct from the indigo Enterprises grid. Each card shows
// the partner's brand mark (first-letter avatar in their brand color),
// display name, subdomain chip, and rollup stats (clients, enterprises,
// linked users, Partner Books present/absent).
//
// Data source: `GET /api/superadmin/partners` — the rollup counts are
// pre-computed server-side so this grid is one cheap fetch even at
// hundreds of partners.
// --------------------------------------------------------------------------
function PartnersGrid({ partners, loading, layout = "grid" }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-slate-500 flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading partners…
      </div>
    );
  }
  if (!partners.length) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-slate-500">
        No partners yet. Click <span className="font-medium text-slate-700">New Partner</span> to create your first reseller (e.g. CypherPro).
      </div>
    );
  }
  if (layout === "list") {
    return (
      <div className="rounded-xl border border-slate-200 overflow-hidden bg-white"
            data-testid="partners-list">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[10px] uppercase tracking-widest text-slate-500">
              <th className="px-4 py-2">Partner</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Subdomain</th>
              <th className="px-4 py-2 text-right">Clients</th>
              <th className="px-4 py-2 text-right">Enterprises</th>
              <th className="px-4 py-2 text-right">Users</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {partners.map(p => {
              const brandColor = p.primary_color || "#ea580c";
              const s = p.stats || {};
              return (
                <tr key={p.id} className="hover:bg-slate-50"
                    data-testid={`partner-row-${p.id}`}>
                  <td className="px-4 py-2">
                    <Link to={`/admin/partners/${p.id}`}
                          data-testid={`open-partner-row-${p.id}`}
                          className="inline-flex items-center gap-2 font-semibold text-slate-900 hover:text-orange-700">
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded font-semibold text-white text-[10px]"
                        style={{ backgroundColor: brandColor }}
                      >
                        {(p.display_name || p.name || "?").charAt(0).toUpperCase()}
                      </span>
                      {p.display_name || p.name}
                      {p.must_set_password && (
                        <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                          Awaiting pw
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-600 text-xs truncate max-w-[200px]">{p.email}</td>
                  <td className="px-4 py-2 text-slate-500 font-mono text-[11px]">
                    {p.subdomain ? `${p.subdomain}.accountingapp.ai` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono-num text-cyan-700">{s.clients ?? 0}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-indigo-700">{s.enterprises ?? 0}</td>
                  <td className="px-4 py-2 text-right font-mono-num text-slate-700">{s.linked_users ?? 0}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {s.has_partner_books && s.partner_books_company_id && (
                      <Link
                        to={`/companies/${s.partner_books_company_id}`}
                        className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100 mr-1"
                      >
                        <BookOpen size={10} /> Books
                      </Link>
                    )}
                    <Link to={`/admin/partners/${p.id}`}
                          className="text-orange-700 hover:text-orange-900 text-[11px] font-medium">
                      Open →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="partners-grid">
      {partners.map((p) => {
        const brandColor = p.primary_color || "#ea580c";
        const s = p.stats || {};
        return (
          <div
            key={p.id}
            data-testid={`partner-card-${p.id}`}
            className="group relative rounded-xl p-[1.5px] bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500 shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="rounded-[10px] bg-white p-4 h-full flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center justify-center w-7 h-7 rounded font-semibold text-white text-xs flex-shrink-0"
                      style={{ backgroundColor: brandColor }}
                      title={p.display_name}
                    >
                      {(p.display_name || p.name || "?").charAt(0).toUpperCase()}
                    </span>
                    <div className="font-heading font-semibold text-lg truncate">
                      {p.display_name || p.name}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 mt-1 truncate">
                    {p.email}
                  </div>
                  {p.subdomain && (
                    <div className="text-[11px] text-slate-500 mt-1 font-mono truncate">
                      {p.subdomain}.accountingapp.ai
                    </div>
                  )}
                </div>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200 font-medium flex-shrink-0">
                  Partner
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-md bg-cyan-50/60 p-2">
                  <div className="text-[10px] uppercase text-cyan-700 flex items-center gap-1">
                    <Ticket size={10} /> Clients
                  </div>
                  <div className="font-mono-num font-semibold text-cyan-800">{s.clients ?? 0}</div>
                </div>
                <div className="rounded-md bg-indigo-50/60 p-2">
                  <div className="text-[10px] uppercase text-indigo-700 flex items-center gap-1">
                    <Building2 size={10} /> Enterprises
                  </div>
                  <div className="font-mono-num font-semibold text-indigo-800">{s.enterprises ?? 0}</div>
                </div>
                <div className="rounded-md bg-slate-50 p-2">
                  <div className="text-[10px] uppercase text-slate-600 flex items-center gap-1">
                    <Users2 size={10} /> Users
                  </div>
                  <div className="font-mono-num font-semibold text-slate-800">{s.linked_users ?? 0}</div>
                </div>
              </div>

              <div className="mt-3 flex-1 text-[11px] text-slate-600 space-y-1">
                {s.has_partner_books && s.partner_books_company_id && (
                  <Link
                    to={`/companies/${s.partner_books_company_id}`}
                    data-testid={`partner-books-open-${p.id}`}
                    className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100"
                  >
                    <BookOpen size={11} />
                    Partner Books
                    <ExternalLink size={9} />
                  </Link>
                )}
                {p.must_set_password && (
                  <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 mt-1 inline-block">
                    Awaiting password set
                  </div>
                )}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100">
                <Link
                  to={`/admin/partners/${p.id}`}
                  data-testid={`open-partner-${p.id}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 hover:text-orange-900"
                >
                  Open partner <ExternalLink size={11} />
                </Link>
              </div>
            </div>
          </div>
        );
      })}
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


// SuperadminKpi — tinted click-to-filter card at the top of the
// superadmin Clients page (Round 7.14). Same visual language as the
// FirmStat rollup but standalone so it can flip the mode-toggle.
const SUPERADMIN_KPI_TONE = {
  fuchsia: { border: "border-fuchsia-100", bg: "bg-fuchsia-50/70", ring: "bg-fuchsia-100 text-fuchsia-700", num: "text-fuchsia-700" },
  orange:  { border: "border-orange-100",  bg: "bg-orange-50/70",  ring: "bg-orange-100 text-orange-700",  num: "text-orange-700" },
  indigo:  { border: "border-indigo-100",  bg: "bg-indigo-50/70",  ring: "bg-indigo-100 text-indigo-700",  num: "text-indigo-700" },
  cyan:    { border: "border-cyan-100",    bg: "bg-cyan-50/70",    ring: "bg-cyan-100 text-cyan-700",      num: "text-cyan-700" },
};
function SuperadminKpi({ label, value, icon: Icon, tone, onClick, testid }) {
  const t = SUPERADMIN_KPI_TONE[tone] || SUPERADMIN_KPI_TONE.cyan;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`text-left rounded-xl border ${t.border} ${t.bg} p-4 flex items-center gap-3 hover:shadow-sm transition`}
    >
      <div className={`w-9 h-9 rounded-full flex items-center justify-center ${t.ring} flex-shrink-0`}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{label}</div>
        <div className={`text-3xl font-heading font-bold ${t.num} leading-tight mt-0.5`}>{value}</div>
      </div>
    </button>
  );
}


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

/**
 * InsightsCostAlertTile — surfaces clients whose current-month Insights
 * spend has crossed the firm's configured threshold. Silent when the
 * threshold is 0 (feature disabled) OR when nobody is over.
 *
 * The tile inlines a "Set threshold" button so the firm can adjust the
 * value without leaving the page. Threshold persists per-Pro-user on
 * the backend (`insights_alert_threshold_usd` on the user doc).
 */
function InsightsCostAlertTile({ onOpenClient }) {
  const [threshold, setThreshold] = useState(0);
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const load = async () => {
    try {
      const cfg = await api.get("/pro/insights-cost-alerts/config");
      const t = Number(cfg.data?.threshold_usd || 0);
      setThreshold(t);
      const list = await api.get("/pro/insights-cost-alerts", { params: { threshold_usd: t } });
      setData(list.data);
    } catch (e) { /* silent — this tile is non-critical */ }
  };
  useEffect(() => { load(); }, []);

  const saveThreshold = async () => {
    const v = Math.max(0, Number(draft) || 0);
    try {
      await api.patch("/pro/insights-cost-alerts/config", { threshold_usd: v });
      setThreshold(v);
      setEditing(false);
      toast.success(v > 0 ? `Alert set for clients spending ≥ $${v.toFixed(2)}/mo` : "Cost alerts disabled");
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't save threshold");
    }
  };

  // Compact "configure" chip when threshold hasn't been set. Keeps
  // the feature discoverable without shouting for attention.
  if (threshold <= 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white/60 px-4 py-2 flex flex-wrap items-center gap-3"
           data-testid="insights-cost-alert-tile-disabled">
        <Sparkles size={14} className="text-indigo-500" />
        <div className="text-xs text-slate-600 flex-1 min-w-0">
          Set a monthly Insights-spend alert so you know when a client is burning through their AI budget.
        </div>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500">$</span>
            <input
              type="number" min="0" step="0.50" autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveThreshold(); if (e.key === "Escape") setEditing(false); }}
              data-testid="insights-cost-alert-threshold-input"
              className="w-24 text-xs px-2 py-1 rounded border border-slate-300"
              placeholder="5.00"
            />
            <button onClick={saveThreshold} data-testid="insights-cost-alert-threshold-save"
                    className="text-xs px-2.5 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">Save</button>
            <button onClick={() => setEditing(false)}
                    className="text-xs px-2 py-1 text-slate-500 hover:text-slate-800">Cancel</button>
          </div>
        ) : (
          <button
            onClick={() => { setDraft("5"); setEditing(true); }}
            data-testid="insights-cost-alert-configure-btn"
            className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
          >
            Set threshold
          </button>
        )}
      </div>
    );
  }

  const over = data?.clients_over || [];
  // Threshold is set but nobody is over — show a compact "all clear" strip.
  if (!over.length) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-2 flex items-center gap-3"
           data-testid="insights-cost-alert-tile-clear">
        <CheckCircle2 size={14} className="text-emerald-600" />
        <div className="text-xs text-emerald-900 flex-1">
          All clients under your ${threshold.toFixed(2)}/mo Insights alert threshold this month.
        </div>
        <button
          onClick={() => { setDraft(String(threshold)); setEditing(true); }}
          className="text-xs text-emerald-800 hover:text-emerald-950 underline"
        >
          Change threshold
        </button>
        {editing && (
          <ThresholdEditor draft={draft} setDraft={setDraft}
                           onSave={saveThreshold} onCancel={() => setEditing(false)} />
        )}
      </div>
    );
  }

  // At least one client is over → LOUD warning tile.
  return (
    <div className="rounded-xl border border-rose-200 bg-gradient-to-r from-rose-50 to-white overflow-hidden shadow-sm"
         data-testid="insights-cost-alert-tile">
      <div className="px-5 py-3 flex flex-wrap items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-rose-100 grid place-items-center animate-pulse">
          <AlertTriangle size={16} className="text-rose-700" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-heading font-semibold text-rose-900">
            <span data-testid="insights-cost-alert-count">{over.length}</span> client{over.length === 1 ? "" : "s"} over your Insights budget alert
          </h3>
          <div className="text-xs text-rose-800/80 mt-0.5">
            Threshold: <b>${threshold.toFixed(2)}/mo</b> · Period: {data.period}
          </div>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          data-testid="insights-cost-alert-expand-btn"
          className="text-xs px-3 py-1.5 rounded-md border border-rose-300 bg-white hover:bg-rose-50 text-rose-800"
        >
          {expanded ? "Hide list" : "Show list"}
        </button>
        <button
          onClick={() => { setDraft(String(threshold)); setEditing(true); }}
          className="text-xs px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
        >
          Edit threshold
        </button>
      </div>
      {editing && (
        <div className="px-5 pb-3">
          <ThresholdEditor draft={draft} setDraft={setDraft}
                           onSave={saveThreshold} onCancel={() => setEditing(false)} />
        </div>
      )}
      {expanded && (
        <div className="border-t border-rose-100 divide-y divide-rose-50 bg-white">
          {over.map((c) => (
            <div key={c.id} className="px-5 py-2.5 flex items-center gap-3"
                 data-testid={`insights-cost-alert-row-${c.id}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{c.name}</div>
                <div className="text-[11px] text-slate-500">
                  Spent <b className="font-mono-num text-slate-800">${c.spent.toFixed(2)}</b>
                  {" · "}Over by <b className="font-mono-num text-rose-700">${c.over_by.toFixed(2)}</b>
                </div>
              </div>
              <button
                onClick={() => onOpenClient && onOpenClient(c.id)}
                className="text-xs px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                data-testid={`insights-cost-alert-open-${c.id}`}
              >
                Open books
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThresholdEditor({ draft, setDraft, onSave, onCancel }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500">$</span>
      <input
        type="number" min="0" step="0.50" autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
        data-testid="insights-cost-alert-threshold-input"
        className="w-28 text-xs px-2 py-1 rounded border border-slate-300"
        placeholder="5.00"
      />
      <button onClick={onSave} data-testid="insights-cost-alert-threshold-save"
              className="text-xs px-2.5 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">Save</button>
      <button onClick={onCancel}
              className="text-xs px-2 py-1 text-slate-500 hover:text-slate-800">Cancel</button>
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



export function NewClientModal({ onClose, onCreated, partnerId }) {
  const ukEnabled = useFeatureFlag("regions.uk_enabled");
  const [form, setForm] = useState({
    company_name: "", business_type: "", business_description: "",
    client_name: "", client_email: "", client_password: "",
    reporting_basis: "accrual",
    // Region — US default. Only exposed in the UI when the UK flag is
    // on, so US-only Pros never see it and every existing test/
    // regression flow submits without the field, which the backend
    // resolves to US (identical to pre-Phase-1 behaviour).
    region: "US",
    // Phase B billing intent — populated once billing context lands.
    billing_payer: "client_email",
    billing_product: "simple_start",
    billing_discount: false,
    // Default ON — matches historical behaviour (welcome email always sent).
    // Enterprise/pro can flip off to skip the client email at create time
    // and re-send later via the row-level "resend welcome" action.
    send_welcome_email: true,
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
      // Superadmin can attribute this client under a specific
      // Partner when the dialog is launched from a Partner detail
      // page. Ignored by the backend for Partner callers.
      const payload = partnerId ? { ...form, partner_id: partnerId } : form;
      const r = await api.post("/pro/clients", payload);
      const status = r.data.email_status;
      const err = r.data.email_error;
      const emailOk = status === "sent";
      const emailNote =
        status === "sent" ? "we've emailed them the good news."
        : status === "skipped_by_pro" ? "welcome email skipped per your toggle — click \"Re-send welcome\" on the client row anytime to send it."
        : status === "skipped_pref_off" ? "email skipped — your welcome-email preference is off. Toggle it back on under Settings → Notifications if you meant to send."
        : status === "skipped_no_email" ? "no email on file, so nothing was sent."
        : `email FAILED to send${err ? ` (${err.slice(0,140)})` : ""} — check Communications for details.`;
      if (r.data.reused_existing_user) {
        (emailOk || status === "skipped_by_pro" ? toast.success : toast.error)(
          `${form.company_name} added to ${form.client_email}'s existing login. They now own ${r.data.owner_company_count} companies — ${emailNote}`,
          { duration: (emailOk || status === "skipped_by_pro") ? 7000 : 12000 },
        );
      } else {
        (emailOk || status === "skipped_by_pro" ? toast.success : toast.error)(
          `Client "${form.client_name}" created — ${emailNote.replace(/^we've emailed them the good news\.$/, `they'll get a "Set your password" email at ${form.client_email}.`)}`,
          { duration: (emailOk || status === "skipped_by_pro") ? 7000 : 12000 },
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
      onCreated(r.data.company_id);
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
          {/* Region selector — only rendered when the UK region is
              enabled cluster-wide via the `regions.uk_enabled` feature
              flag. US-only firms literally never see this control, so
              their New Client experience is bit-identical to before. */}
          {ukEnabled && (
            <div data-testid="new-client-region-block">
              <label className="text-xs text-slate-600">Country</label>
              <select
                data-testid="new-client-region"
                value={form.region}
                onChange={(e) => update("region", e.target.value)}
                className="w-full mt-1 border rounded px-2 py-1.5 bg-white"
              >
                {Object.values(REGIONS).map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.displayName} ({r.currency})
                  </option>
                ))}
              </select>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Determines the starter chart of accounts, currency, and tax treatment. Change later via Company Settings.
              </div>
            </div>
          )}
          <div>
            <label className="text-xs text-slate-600">Company name</label>
            <input data-testid="new-client-company-name" value={form.company_name}
                   onChange={(e) => update("company_name", e.target.value)}
                   className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-600">Business type</label>
              <select
                data-testid="new-client-business-type"
                value={form.business_type}
                onChange={(e) => update("business_type", e.target.value)}
                className="w-full mt-1 border rounded px-2 py-1.5 bg-white"
              >
                <option value="">— Select entity type —</option>
                {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
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

          {/* Welcome-email toggle. Defaults ON (client gets the same email as
              before). Toggle OFF lets an enterprise user quietly provision a
              client without notifying them — useful when the pro is setting
              up the books ahead of a kickoff call or the client will be
              invited later out-of-band. Can be re-sent later via the
              "Re-send welcome" pencil on each client row. */}
          <label
            className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover:bg-slate-100 transition"
            data-testid="new-client-send-welcome-toggle-label"
          >
            <input
              type="checkbox"
              checked={form.send_welcome_email}
              onChange={(e) => update("send_welcome_email", e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              data-testid="new-client-send-welcome-toggle"
            />
            <div className="text-xs leading-relaxed">
              <div className="font-medium text-slate-800">
                Send the client a welcome / password-set email now
              </div>
              <div className="text-slate-500 mt-0.5">
                {form.send_welcome_email
                  ? "On — the client will get their sign-in email as soon as you click Create."
                  : "Off — no email will be sent. You can send it later from the client row."}
              </div>
            </div>
          </label>

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
export function NewEnterpriseModal({ onClose, onCreated, partnerId }) {
  const { user } = useAuth();
  // Partner users are capped at 2 free spots per enterprise they
  // provision (business policy — Partners resell paid seats). The
  // backend enforces the same cap so a Partner can't bypass this by
  // hitting the API directly.
  const PARTNER_MAX_FREE_SPOTS = 2;
  const isPartner = user?.role === "partner";
  const freeSpotsMax = isPartner ? PARTNER_MAX_FREE_SPOTS : 10000;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  // Superadmin-only: seed an initial password so they can share
  // credentials directly with the owner Pro. If left blank, the
  // welcome email's magic-link is the sole path (existing behavior).
  const [ownerPassword, setOwnerPassword] = useState("");
  const [freeSpots, setFreeSpots] = useState(0);
  const [defaultProduct, setDefaultProduct] = useState("simple_start");
  const [defaultDiscount, setDefaultDiscount] = useState(false);
  const [busy, setBusy] = useState(false);
  // Partner WL-comp quota — fetched on mount so the checkbox shows
  // the accurate "X of 2 used" count and greys out at the cap. Only
  // relevant when the caller is a partner.
  // Comp UI visibility: shown when caller IS a Partner (their own
  // comp allowance) OR when a Superadmin opened this modal from a
  // Partner detail page (partnerId prop set). Round 7.24, Feb 2026.
  const canShowComp = isPartner || !!partnerId;
  const [compOwnerWL, setCompOwnerWL] = useState(false);
  const [wlComps, setWlComps] = useState(null); // { used, cap, remaining }
  useEffect(() => {
    if (!isPartner) return;
    api.get("/partner/wl-comps").then(r => setWlComps(r.data))
      .catch(() => setWlComps({ used: 0, cap: 2, remaining: 2 }));
  }, [isPartner]);

  const slugify = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effectiveSlug = slug.trim() || slugify(name);
  // Basic client-side email sanity — server does the authoritative check.
  const ownerEmailValid = !ownerEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim());

  const save = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (ownerEmail.trim() && !ownerEmailValid) { toast.error("Owner email looks invalid"); return; }
    if (ownerEmail.trim() && !ownerName.trim()) { toast.error("Owner name is required when you supply an email"); return; }
    // Partner comp requires a target user — reject with a helpful
    // toast if the checkbox is on but no owner was supplied.
    if (canShowComp && compOwnerWL && !ownerEmail.trim()) {
      toast.error("Add an Owner login email — comps attach to a Pro user account.");
      return;
    }
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
        // Optional initial password (superadmin scope only — the
        // backend ignores this field when the caller is a Partner).
        if (ownerPassword.trim()) {
          payload.owner_password = ownerPassword;
        }
      }
      // Attribute this enterprise under a specific partner when the
      // Add Enterprise dialog is launched from a Partner detail page.
      // Backend ignores this field for Partner callers (they already
      // stamp their own id automatically).
      if (partnerId) payload.partner_id = partnerId;
      // Ship the comp flag whenever the visible checkbox is on AND
      // the owner email is set (server rechecks quota / role — this
      // is UX, not enforcement).
      if (canShowComp && compOwnerWL && ownerEmail.trim()) {
        payload.comp_owner_whitelabel = true;
      }
      const r = await api.post("/admin/enterprises", payload);
      const emailStatus = r.data?.email_status;
      const ownerProvisioned = r.data?.owner_provisioned;
      const compApplied = r.data?.comp_applied;
      if (ownerProvisioned && emailStatus === "sent") {
        toast.success(`Enterprise created — magic-link login sent to ${ownerEmail.trim()}`);
      } else if (ownerProvisioned) {
        toast.success(`Enterprise created — owner account provisioned (email dispatch: ${emailStatus || "unknown"})`);
      } else {
        toast.success(`Enterprise "${name.trim()}" created`);
      }
      if (compApplied) {
        toast.success("White-label comp applied to the enterprise owner.");
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
            {/* Superadmin-only optional password (Round 7.25). Hidden
                for Partner callers — Partners always use the
                magic-link flow for auditability. */}
            {!isPartner && ownerEmail.trim() && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Initial password <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  data-testid="new-enterprise-owner-password"
                  type="text"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  placeholder="Leave blank to force magic-link only"
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white font-mono"
                />
                <div className="text-[11px] text-slate-500 mt-1 leading-snug">
                  If set, the owner can sign in immediately with this password.
                  The welcome email's magic-link still works, so they can reset it later.
                </div>
              </div>
            )}
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
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Free spots
                {isPartner && (
                  <span className="ml-1 font-normal text-slate-400">
                    (max {PARTNER_MAX_FREE_SPOTS} for partners)
                  </span>
                )}
              </label>
              <input
                data-testid="new-enterprise-free-spots"
                type="number"
                min="0"
                max={freeSpotsMax}
                value={freeSpots}
                onChange={(e) => {
                  // Client-side clamp so the field never even briefly
                  // holds an out-of-range value for the current role.
                  const raw = Number(e.target.value);
                  if (Number.isNaN(raw)) return;
                  setFreeSpots(Math.max(0, Math.min(freeSpotsMax, raw)));
                }}
                className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>
          {/* Partner WL-comp toggle — burn one of the 2 available
              "comp white-label" slots to give this enterprise's owner
              a free private-label upgrade. Only rendered for
              partners. The checkbox is enabled whenever the quota
              still has room — the owner-email requirement is
              validated at submit-time (inline warning) so the user
              can check the box in any order they like. */}
          {canShowComp && (
            <label
              data-testid="new-enterprise-comp-wl-label"
              className={`flex items-start gap-2 text-sm rounded-md border p-3 ${
                compOwnerWL
                  ? "border-indigo-200 bg-indigo-50"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <input
                data-testid="new-enterprise-comp-wl"
                type="checkbox"
                checked={compOwnerWL}
                disabled={isPartner && wlComps && wlComps.remaining <= 0}
                onChange={(e) => setCompOwnerWL(e.target.checked)}
                className="mt-0.5 rounded border-slate-300"
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-800">
                  Comp white-label for this enterprise owner
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {isPartner
                    ? (wlComps
                        ? (
                          <>
                            You've used{" "}
                            <span className="font-mono-num font-semibold">{wlComps.used}</span>
                            {" "}of{" "}
                            <span className="font-mono-num font-semibold">{wlComps.cap}</span>
                            {" "}partner comps.
                            {wlComps.remaining <= 0
                              ? " No comps remaining — revoke an existing one to grant another."
                              : ` ${wlComps.remaining} left after this one is used.`}
                          </>
                        )
                        : "Checking your comp quota…")
                    : "Superadmin grant — the owner Pro will get white-label unlocked without a Stripe charge."}
                </div>
                {compOwnerWL && !ownerEmail.trim() && (
                  <div
                    data-testid="new-enterprise-comp-wl-warn"
                    className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                  >
                    Add an Owner login email above — comps attach to a
                    Pro user account, so we need someone to grant it to.
                  </div>
                )}
              </div>
            </label>
          )}
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
