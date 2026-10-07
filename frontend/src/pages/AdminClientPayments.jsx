// Superadmin → Client Payments: who's current, who's behind, what's due next.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  CreditCard, RefreshCw, Search, ExternalLink, AlertTriangle, Clock, CheckCircle2,
  XCircle, Shield, Gift, Loader2, X, Receipt, Building2, Hourglass,
} from "lucide-react";

const money = (c) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 86400000) : null);

const STATUS = {
  trialing:   { label: "Trialing",       cls: "bg-sky-50 text-sky-700 border-sky-200",          dot: "bg-sky-500",     Icon: Hourglass },
  active:     { label: "Active",         cls: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", Icon: CheckCircle2 },
  past_due:   { label: "Past due",       cls: "bg-rose-50 text-rose-700 border-rose-200",        dot: "bg-rose-500",    Icon: AlertTriangle },
  canceled:   { label: "Canceled",       cls: "bg-slate-100 text-slate-600 border-slate-200",    dot: "bg-slate-400",   Icon: XCircle },
  pending:    { label: "No subscription", cls: "bg-amber-50 text-amber-700 border-amber-200",    dot: "bg-amber-500",   Icon: Clock },
  enterprise: { label: "Enterprise pays", cls: "bg-indigo-50 text-indigo-700 border-indigo-200", dot: "bg-indigo-500",  Icon: Shield },
  free:       { label: "Free spot",      cls: "bg-violet-50 text-violet-700 border-violet-200",  dot: "bg-violet-500",  Icon: Gift },
  investor:   { label: "Investor",       cls: "bg-amber-50 text-amber-800 border-amber-200",     dot: "bg-amber-500",   Icon: Gift },
};

function StatusPill({ status, sub }) {
  const s = STATUS[status] || STATUS.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium border rounded-full px-2 py-0.5 ${s.cls}`} data-testid={`cp-status-${status}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {s.label}{sub ? <span className="opacity-70 font-normal">· {sub}</span> : null}
    </span>
  );
}

function Metric({ label, value, sub, tone = "slate", testId }) {
  const tones = {
    slate: "bg-white", emerald: "bg-emerald-50/60", sky: "bg-sky-50/60", rose: "bg-rose-50/60", amber: "bg-amber-50/60", indigo: "bg-indigo-50/60",
  };
  return (
    <div className={`rounded-xl border border-slate-200 p-4 ${tones[tone]}`} data-testid={testId}>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{label}</div>
      <div className="mt-1 text-2xl font-heading font-bold text-slate-900 font-mono-num">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function statusSub(r) {
  if (r.status === "trialing") { const d = daysUntil(r.trial_end); return d != null ? `ends in ${d}d` : null; }
  if (r.status === "past_due") { const d = daysUntil(r.last_failure?.next_payment_attempt); return d != null ? `retry in ${d}d` : "needs card"; }
  if (r.status === "active" && r.cancel_at_period_end) return `ends ${fmtDate(r.current_period_end)}`;
  if (r.status === "canceled" && r.canceled_at) return fmtDate(r.canceled_at);
  return null;
}

export default function AdminClientPayments() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(params.get("status") || "all");
  const [plan, setPlan] = useState("all");
  const [cadence, setCadence] = useState("all");
  const [ent, setEnt] = useState("all");
  const [selected, setSelected] = useState(params.get("client") || null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try { const r = await api.get("/admin/client-payments"); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.detail || "Couldn't load client payments"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post("/admin/client-payments/backfill");
      toast.success(`Synced ${r.data.synced} of ${r.data.total} subscriptions from Stripe${r.data.failed?.length ? ` · ${r.data.failed.length} failed` : ""}`);
      await load();
    } catch (e) { toast.error(e.response?.data?.detail || "Sync failed"); }
    finally { setSyncing(false); }
  };

  const rows = data?.rows || [];
  const enterprises = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => { if (r.enterprise_id) m.set(r.enterprise_id, r.enterprise_name); });
    return [...m.entries()];
  }, [rows]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (status === "all" || r.status === status) &&
      (plan === "all" || r.product === plan) &&
      (cadence === "all" || r.cadence === cadence) &&
      (ent === "all" || (ent === "direct" ? !r.enterprise_id : r.enterprise_id === ent)) &&
      (!needle || [r.company_name, r.owner_name, r.owner_email, r.enterprise_name].some((v) => (v || "").toLowerCase().includes(needle)))
    );
  }, [rows, q, status, plan, cadence, ent]);

  const openClient = (cid) => { setSelected(cid); setParams((p) => { p.set("client", cid); return p; }, { replace: true }); };
  const closeClient = () => { setSelected(null); setParams((p) => { p.delete("client"); return p; }, { replace: true }); };

  const m = data?.metrics || {};
  const isPlatform = data?.scope !== "enterprise";
  const noSnapshot = isPlatform ? rows.filter((r) => r.stripe_subscription_id && !r.has_snapshot).length : 0;

  return (
    <div className="p-6 lg:p-8 max-w-[1400px]" data-testid="admin-client-payments-page">
      <div className="flex flex-wrap items-start gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="font-heading text-3xl font-bold text-slate-900 flex items-center gap-3">
            <CreditCard size={26} className="text-indigo-600" /> Client Payments
          </h1>
          <p className="text-sm text-slate-500 mt-1">{isPlatform ? "Every self-serve and pro-billed subscription · who's current, who's behind, what's due next." : "Your clients' subscriptions · who's current, who's behind, what's due next."}</p>
        </div>
        {isPlatform && (
        <div className="ml-auto flex items-center gap-2">
          {data?.stripe_mode && (
            <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded ${data.stripe_mode === "live" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`} data-testid="cp-stripe-mode">
              Stripe {data.stripe_mode}
            </span>
          )}
          <button onClick={sync} disabled={syncing} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60" data-testid="cp-sync-btn">
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync from Stripe
          </button>
          <a href="https://dashboard.stripe.com/subscriptions" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800" data-testid="cp-open-stripe">
            Open Stripe <ExternalLink size={13} />
          </a>
        </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <Metric label="MRR" value={money(m.mrr_cents)} sub="active + past due, annual ÷ 12" tone="emerald" testId="cp-metric-mrr" />
        <Metric label="Active" value={m.active ?? "—"} sub="paying subscriptions" testId="cp-metric-active" />
        <Metric label="Trialing" value={m.trialing ?? "—"} sub="not yet charged" tone="sky" testId="cp-metric-trialing" />
        <Metric label="Past due" value={m.past_due ?? "—"} sub={m.past_due ? `${money(m.past_due_cents)} outstanding` : "nothing outstanding"} tone="rose" testId="cp-metric-past-due" />
        <Metric label="Due next 30 days" value={money(m.due_30d_cents)} sub={`${m.due_30d ?? 0} charges scheduled`} tone="amber" testId="cp-metric-due" />
        <Metric label="Enterprise / free" value={m.enterprise_paid ?? "—"} sub={`${m.churned_30d ?? 0} churned in 30d`} tone="indigo" testId="cp-metric-enterprise" />
      </div>

      {noSnapshot > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2" data-testid="cp-snapshot-hint">
          <AlertTriangle size={14} /> {noSnapshot} subscription{noSnapshot === 1 ? "" : "s"} missing next-charge details — click <b>Sync from Stripe</b> once to backfill.
        </div>
      )}

      {data?.attention?.length > 0 && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50/50 p-4" data-testid="cp-attention">
          <div className="text-sm font-semibold text-rose-800 flex items-center gap-2 mb-2"><AlertTriangle size={15} /> {data.attention.length} client{data.attention.length === 1 ? " needs" : "s need"} attention</div>
          <div className="divide-y divide-rose-100">
            {data.attention.map((r) => (
              <div key={r.company_id} className="py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <button onClick={() => openClient(r.company_id)} className="font-medium text-slate-900 hover:underline" data-testid={`cp-attention-${r.company_id}`}>{r.company_name}</button>
                <span className="text-slate-500">{r.product_label} · {money(r.amount_cents)}</span>
                <span className="text-rose-700">
                  {r.status === "past_due"
                    ? `${money(r.last_failure?.amount_cents ?? r.amount_cents)} failed${r.last_failure?.at ? ` ${fmtDate(r.last_failure.at)}` : ""}${r.last_failure?.next_payment_attempt ? ` · retry ${fmtDate(r.last_failure.next_payment_attempt)}` : ""}`
                    : `trial ends ${fmtDate(r.trial_end)} · ${money(r.amount_cents)} will be charged`}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {r.last_failure?.hosted_invoice_url && (
                    <a href={r.last_failure.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-xs px-2 py-1 rounded border border-rose-200 bg-white hover:bg-rose-50 text-rose-700">Invoice link</a>
                  )}
                  <button onClick={() => openClient(r.company_id)} className="text-xs px-2 py-1 rounded bg-slate-900 text-white">Open</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, owner, email, enterprise…" className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200" data-testid="cp-search" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="text-sm rounded-md border border-slate-200 bg-white px-2.5 py-2" data-testid="cp-filter-status">
          <option value="all">All statuses</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={plan} onChange={(e) => setPlan(e.target.value)} className="text-sm rounded-md border border-slate-200 bg-white px-2.5 py-2" data-testid="cp-filter-plan">
          <option value="all">All plans</option>
          <option value="simple_start">Core / Simple Start</option>
          <option value="assistant">AI Assistant</option>
          <option value="bookkeeper">AI Bookkeeper</option>
          <option value="advanced">Advanced</option>
          <option value="essentials">Essentials</option>
          <option value="plus">Plus</option>
        </select>
        <select value={cadence} onChange={(e) => setCadence(e.target.value)} className="text-sm rounded-md border border-slate-200 bg-white px-2.5 py-2" data-testid="cp-filter-cadence">
          <option value="all">Monthly + annual</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
        {isPlatform && (
        <select value={ent} onChange={(e) => setEnt(e.target.value)} className="text-sm rounded-md border border-slate-200 bg-white px-2.5 py-2" data-testid="cp-filter-enterprise">
          <option value="all">All enterprises</option>
          <option value="direct">No enterprise</option>
          {enterprises.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        )}
        <span className="text-xs text-slate-500 ml-auto tabular-nums" data-testid="cp-count">{visible.length} of {rows.length}</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="cp-table">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Client</th>
              {isPlatform && <th className="text-left px-4 py-2.5 font-medium">Enterprise</th>}
              <th className="text-left px-4 py-2.5 font-medium">Plan</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Next charge</th>
              <th className="text-right px-4 py-2.5 font-medium">Lifetime</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && <tr><td colSpan={isPlatform ? 6 : 5} className="px-4 py-10 text-center text-slate-400"><Loader2 size={18} className="animate-spin inline" /></td></tr>}
            {!loading && !visible.length && <tr><td colSpan={isPlatform ? 6 : 5} className="px-4 py-10 text-center text-slate-400">No clients match these filters.</td></tr>}
            {visible.map((r) => (
              <tr key={r.company_id} onClick={() => openClient(r.company_id)} className="hover:bg-slate-50 cursor-pointer transition" data-testid={`cp-row-${r.company_id}`}>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{r.company_name}</div>
                  <div className="text-[11px] text-slate-400 truncate max-w-[220px]">{r.owner_name || "—"}{r.owner_email ? ` · ${r.owner_email}` : ""}</div>
                </td>
                {isPlatform && (
                <td className="px-4 py-2.5 text-slate-600">{r.enterprise_name || <span className="text-slate-400">No enterprise</span>}</td>
                )}
                <td className="px-4 py-2.5">
                  <div className="text-slate-800">{r.product_label || <span className="text-slate-400">—</span>}</div>
                  <div className="text-[11px] text-slate-400">{r.amount_cents != null ? `${r.cadence === "annual" ? "Annual" : "Monthly"} · ${money(r.amount_cents)}${r.cadence === "annual" ? "/yr" : "/mo"}` : (r.cadence === "annual" ? "Annual" : "Monthly")}</div>
                </td>
                <td className="px-4 py-2.5"><StatusPill status={r.status} sub={statusSub(r)} /></td>
                <td className="px-4 py-2.5">
                  {r.next_charge_at ? (
                    <>
                      <div className="text-slate-800 font-mono-num">{fmtDate(r.next_charge_at)}</div>
                      <div className="text-[11px] text-slate-400">{money(r.next_charge_cents)}{r.status === "trialing" ? " · first charge" : ""}</div>
                    </>
                  ) : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num text-slate-700">{money(r.ltv_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <ClientDrawer cid={selected} onClose={closeClient} showStripe={isPlatform} onChanged={() => load(true)} />}
    </div>
  );
}

function BillingActions({ client: c, onChanged }) {
  const [busy, setBusy] = useState(null); // "cancel" | "plan" | "portal"
  const [showPlan, setShowPlan] = useState(false);
  const [product, setProduct] = useState(c.product || "simple_start");
  const [cadence, setCadence] = useState(c.cadence || "monthly");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const ended = c.status === "canceled";

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try { const r = await fn(); toast.success(typeof okMsg === "function" ? okMsg(r.data) : okMsg); await onChanged?.(); return r; }
    catch (e) { toast.error(e.response?.data?.detail || "Stripe request failed"); }
    finally { setBusy(null); }
  };
  const toggleCancel = () => run("cancel",
    () => api.post(`/admin/client-payments/${c.company_id}/cancel`, { cancel: !c.cancel_at_period_end }),
    (d) => d.cancel_at_period_end ? `Cancels ${fmtDate(d.current_period_end)} — access continues until then.` : "Cancellation reversed — subscription will renew.")
    .then(() => setConfirmCancel(false));
  const changePlan = () => run("plan",
    () => api.post(`/admin/client-payments/${c.company_id}/change-plan`, { product, cadence }),
    (d) => `Plan changed to ${PLAN_OPTIONS.find((p) => p.value === d.product)?.label} · ${d.cadence} (${money(d.amount_cents)}). Proration applied.`)
    .then(() => setShowPlan(false));
  const portal = () => run("portal",
    () => api.post(`/admin/client-payments/${c.company_id}/portal`, { return_url: window.location.origin + "/billing" }).then((r) => { window.open(r.data.url, "_blank", "noopener"); return r; }),
    "Customer portal opened in a new tab.");
  const same = product === c.product && cadence === c.cadence;

  return (
    <div className="mt-4 pt-4 border-t border-slate-100" data-testid="cp-actions">
      <div className="flex flex-wrap gap-2">
        {!ended && (
          <button onClick={() => (c.cancel_at_period_end ? toggleCancel() : setConfirmCancel(true))} disabled={busy} className={`text-xs px-2.5 py-1.5 rounded-md border disabled:opacity-60 ${c.cancel_at_period_end ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50" : "border-rose-200 text-rose-700 hover:bg-rose-50"}`} data-testid="cp-action-cancel">
            {busy === "cancel" ? <Loader2 size={12} className="animate-spin inline" /> : c.cancel_at_period_end ? "Undo cancellation" : "Cancel at period end"}
          </button>
        )}
        {!ended && (
          <button onClick={() => setShowPlan((v) => !v)} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-60" data-testid="cp-action-change-plan">Change plan</button>
        )}
        <button onClick={portal} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-50 inline-flex items-center gap-1 disabled:opacity-60" data-testid="cp-action-portal">
          {busy === "portal" ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />} Customer portal
        </button>
      </div>
      {confirmCancel && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800" data-testid="cp-cancel-confirm">
          Cancel <b>{c.company_name}</b>'s {c.product_label} plan at the end of the current period ({fmtDate(c.current_period_end || c.trial_end)})? They keep access until then and are not charged again.
          <div className="mt-2 flex gap-2">
            <button onClick={toggleCancel} disabled={busy} className="px-2.5 py-1 rounded bg-rose-600 text-white" data-testid="cp-cancel-confirm-yes">Yes, cancel at period end</button>
            <button onClick={() => setConfirmCancel(false)} className="px-2.5 py-1 rounded border border-rose-200 bg-white">Keep plan</button>
          </div>
        </div>
      )}
      {showPlan && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3" data-testid="cp-plan-form">
          <div className="flex flex-wrap gap-2 items-center">
            <select value={product} onChange={(e) => setProduct(e.target.value)} className="text-xs rounded-md border border-slate-200 bg-white px-2 py-1.5" data-testid="cp-plan-product">
              {PLAN_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label} · {money(p.monthly)}/mo</option>)}
            </select>
            <select value={cadence} onChange={(e) => setCadence(e.target.value)} className="text-xs rounded-md border border-slate-200 bg-white px-2 py-1.5" data-testid="cp-plan-cadence">
              <option value="monthly">Monthly</option>
              <option value="annual">Annual (2 months free)</option>
            </select>
            <button onClick={changePlan} disabled={busy || same} className="text-xs px-2.5 py-1.5 rounded-md bg-slate-900 text-white disabled:opacity-50" data-testid="cp-plan-apply">
              {busy === "plan" ? <Loader2 size={12} className="animate-spin inline" /> : "Apply change"}
            </button>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">Stripe prorates the difference on the next invoice{c.status === "trialing" ? "; the trial keeps its end date" : ""}.</div>
        </div>
      )}
    </div>
  );
}

const PLAN_OPTIONS = [
  { value: "simple_start", label: "Core", monthly: 3800 },
  { value: "assistant", label: "AI Assistant", monthly: 7900 },
  { value: "bookkeeper", label: "AI Bookkeeper", monthly: 9900 },
  { value: "advanced", label: "Advanced", monthly: 14900 },
];

function ClientDrawer({ cid, onClose, showStripe = true, onChanged }) {
  const [d, setD] = useState(null);
  const load = () => api.get(`/admin/client-payments/${cid}`).then((r) => setD(r.data)).catch(() => { toast.error("Couldn't load client"); onClose(); });
  useEffect(() => {
    setD(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);
  const c = d?.client;
  const stripeCustomerUrl = c?.stripe_customer_id ? `https://dashboard.stripe.com/customers/${c.stripe_customer_id}` : null;
  const refresh = async () => { await load(); onChanged?.(); };
  return (
    <div className="fixed inset-0 z-[900] flex justify-end" data-testid="cp-drawer">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative w-full max-w-[520px] h-full bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="flex items-start gap-3 px-6 py-5 border-b border-slate-200">
          <div className="min-w-0">
            <div className="font-heading text-xl font-bold text-slate-900 truncate" data-testid="cp-drawer-name">{c?.company_name || "…"}</div>
            {c && <div className="text-xs text-slate-500 mt-0.5">{c.owner_name || "—"} · {c.owner_email || "—"}</div>}
            {c && <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5"><Building2 size={11} /> {showStripe ? `${c.enterprise_name || "No enterprise"} · ` : ""}Payer: {c.payer?.replace("_", " ") || "—"}</div>}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {showStripe && stripeCustomerUrl && <a href={stripeCustomerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50" data-testid="cp-drawer-stripe">Stripe <ExternalLink size={11} /></a>}
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-slate-100" data-testid="cp-drawer-close"><X size={16} /></button>
          </div>
        </div>
        {!c ? <div className="p-10 text-center text-slate-400"><Loader2 size={18} className="animate-spin inline" /></div> : (
          <div className="p-6 space-y-6">
            <section className="rounded-xl border border-slate-200 p-4" data-testid="cp-drawer-plan">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Plan</div>
                  <div className="text-lg font-semibold text-slate-900">{c.product_label || "No plan"} {c.amount_cents != null && <span className="text-slate-500 font-normal text-sm">· {c.cadence} · {money(c.amount_cents)}{c.cadence === "annual" ? "/yr" : "/mo"}</span>}</div>
                </div>
                <StatusPill status={c.status} sub={statusSub(c)} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-sm">
                <div><dt className="text-[11px] text-slate-500">Since</dt><dd className="text-slate-800">{fmtDate(c.started_at)}</dd></div>
                <div><dt className="text-[11px] text-slate-500">{c.status === "trialing" ? "Trial ends · first charge" : "Next charge"}</dt><dd className="text-slate-800">{c.next_charge_at ? `${fmtDate(c.next_charge_at)} · ${money(c.next_charge_cents)}` : "—"}</dd></div>
                <div><dt className="text-[11px] text-slate-500">Card on file</dt><dd className="text-slate-800">{c.card || "—"}</dd></div>
                <div><dt className="text-[11px] text-slate-500">Lifetime paid</dt><dd className="text-slate-800 font-mono-num">{money(c.ltv_cents)}</dd></div>
                {c.cancel_at_period_end && <div className="col-span-2 text-amber-700 text-xs">Cancels at period end — access until {fmtDate(c.current_period_end)}.</div>}
                {c.last_failure && (
                  <div className="col-span-2 rounded-md bg-rose-50 border border-rose-200 p-2.5 text-xs text-rose-800">
                    Payment of {money(c.last_failure.amount_cents)} failed {fmtDate(c.last_failure.at)}{c.last_failure.reason ? ` — ${c.last_failure.reason}` : ""}.{c.last_failure.next_payment_attempt ? ` Stripe retries ${fmtDate(c.last_failure.next_payment_attempt)}.` : ""}
                    {c.last_failure.hosted_invoice_url && <a className="underline ml-1" href={c.last_failure.hosted_invoice_url} target="_blank" rel="noreferrer">Open invoice</a>}
                  </div>
                )}
              </dl>
              {c.stripe_subscription_id && <BillingActions client={c} onChanged={refresh} />}
            </section>

            <section data-testid="cp-drawer-payments">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 flex items-center gap-1.5"><Receipt size={12} /> Payment history</div>
              {!d.payments.length ? <div className="text-sm text-slate-400 border border-dashed rounded-lg p-4 text-center">No payments recorded yet{c.status === "trialing" ? " — first charge lands at trial end." : "."}</div> : (
                <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                  {d.payments.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="font-mono-num text-slate-700 w-24">{fmtDate(p.paid_at)}</div>
                      <div className="text-slate-500 text-xs flex-1 truncate">{p.product_label || "—"}{p.billing_cadence ? ` · ${p.billing_cadence}` : ""}{p.billing_reason ? ` · ${p.billing_reason.replace(/_/g, " ")}` : ""}</div>
                      <div className="font-mono-num text-slate-900">{money(p.amount_cents)}</div>
                      {(p.hosted_invoice_url || p.invoice_pdf) && <a href={p.hosted_invoice_url || p.invoice_pdf} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline text-xs">Receipt</a>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section data-testid="cp-drawer-timeline">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 flex items-center gap-1.5"><Clock size={12} /> Timeline</div>
              <ol className="relative border-l border-slate-200 ml-1.5 space-y-2">
                {d.timeline.map((t, i) => (
                  <li key={i} className="pl-4 text-sm">
                    <span className="absolute -left-[5px] mt-1.5 w-2 h-2 rounded-full bg-slate-300" />
                    <span className="text-slate-400 text-xs font-mono-num mr-2">{fmtDate(t.at)}</span>
                    <span className={new Date(t.at) > Date.now() ? "text-slate-400 italic" : "text-slate-800"}>{t.label}{new Date(t.at) > Date.now() ? " (upcoming)" : ""}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
