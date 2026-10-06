import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ExternalLink, ArrowUpRight, Sparkles, Users, Landmark, CalendarClock, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany, useDateFmt, useMoneyFmt } from "@/lib/company";
import { PLAN_ORDER, PLAN_LABELS, PLAN_PRICE } from "@/lib/entitlements";

const q = (v) => (v == null ? "unlimited" : v);

function Row({ icon: Icon, label, value, testid }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-t border-slate-100 first:border-t-0 text-sm" data-testid={testid}>
      <Icon size={15} className="text-slate-400 shrink-0 mt-0.5" />
      <span className="text-slate-500 w-24 sm:w-32 shrink-0">{label}</span>
      <span className="font-medium text-slate-900 break-words min-w-0">{value}</span>
    </div>
  );
}

export function PlanCard() {
  const { currentId } = useCompany();
  const { user } = useAuth();
  const fmtDate = useDateFmt();
  const fmtMoney = useMoneyFmt();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    setD(null);
    if (!currentId) return;
    api.get(`/companies/${currentId}/billing/plan-summary`).then((r) => setD(r.data)).catch(() => setD({ error: true }));
  }, [currentId]);

  const openPortal = async (target) => {
    setBusy(target || "portal");
    try {
      const r = await api.post(`/companies/${currentId}/billing/portal-session`, { origin_url: window.location.origin, return_path: "/billing", target_product: target || undefined });
      if (r.data?.portal_url) { window.location.href = r.data.portal_url; return; }
      throw new Error("No portal URL");
    } catch (e) {
      if (e.response?.data?.detail?.code === "no_subscription") { nav("/pricing"); return; }
      toast.error(e.response?.data?.detail?.message || e.response?.data?.detail || "Couldn't open billing");
      setBusy(null);
    }
  };

  if (!currentId) return null;
  if (!d) return <div className="p-5 text-slate-400 text-sm rounded-xl border border-slate-200 bg-white mb-4"><Loader2 size={14} className="inline animate-spin mr-2" /> Loading plan…</div>;
  if (d.error) return null;

  const isClient = user?.role === "client";
  const money = (c) => fmtMoney(Number(c || 0) / 100);
  const sponsored = ["enterprise", "free_spot"].includes(d.payer || "");
  const nextPlan = d.plan ? PLAN_ORDER[PLAN_ORDER.indexOf(d.plan) + 1] : null;
  const statusChip = d.cancel_at_period_end ? ["Cancels " + (d.current_period_end ? fmtDate(d.current_period_end) : "at period end"), "bg-amber-100 text-amber-800"]
    : d.trialing ? ["Trial" + (d.trial_end ? ` · ends ${fmtDate(d.trial_end)}` : ""), "bg-sky-100 text-sky-800"]
    : d.sub_status === "active" ? ["Active", "bg-emerald-100 text-emerald-800"]
    : d.sub_status === "past_due" ? ["Past due", "bg-rose-100 text-rose-800"]
    : d.sub_status === "canceled" ? ["Canceled", "bg-rose-100 text-rose-800"]
    : sponsored ? [d.payer === "enterprise" ? "Paid by your firm" : "Complimentary", "bg-emerald-100 text-emerald-800"]
    : ["No subscription", "bg-slate-100 text-slate-700"];

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden mb-4" data-testid="plan-card">
      <div className="p-5 flex flex-wrap items-start gap-4 border-b border-slate-100">
        <div className="flex-1 min-w-[220px]">
          <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Current plan</div>
          <div className="flex items-center gap-2 mt-1">
            <h3 className="font-heading text-2xl" data-testid="plan-card-name">{d.plan_label || (d.all_access ? "Full access" : "No plan")}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusChip[1]}`} data-testid="plan-card-status">{statusChip[0]}</span>
          </div>
          {d.amount_cents != null && !sponsored && (
            <div className="text-sm text-slate-600 mt-1" data-testid="plan-card-price">{money(d.amount_cents)} / {d.cadence === "annual" ? "year" : "month"}</div>
          )}
          {!d.plan && d.all_access && <div className="text-sm text-slate-600 mt-1">Every feature is unlocked for this company.</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {d.can_open_portal && (
            <>
              {nextPlan && !sponsored && (
                <button onClick={() => openPortal(nextPlan)} disabled={!!busy} className="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-60" data-testid="plan-card-upgrade">
                  {busy === nextPlan ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Upgrade to {PLAN_LABELS[nextPlan]} · ${PLAN_PRICE[nextPlan]}/mo
                </button>
              )}
              <button onClick={() => openPortal()} disabled={!!busy} className="h-10 px-4 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 inline-flex items-center gap-1.5 disabled:opacity-60" data-testid="plan-card-manage">
                {busy === "portal" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />} Manage billing
              </button>
            </>
          )}
          {!d.can_open_portal && !sponsored && isClient && (
            <button onClick={() => nav("/pricing")} className="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold inline-flex items-center gap-1.5" data-testid="plan-card-choose">
              <ArrowUpRight size={14} /> {d.sub_status === "canceled" ? "Restart a plan" : "Choose a plan"}
            </button>
          )}
        </div>
      </div>
      <div className="px-5 py-2 grid md:grid-cols-2 gap-x-8">
        <div>
          <Row icon={CalendarClock} label="Next invoice" testid="plan-card-next-invoice"
               value={d.next_invoice ? `${money(d.next_invoice.amount_cents)}${d.next_invoice.estimated ? " (est.)" : ""} on ${d.next_invoice.date ? fmtDate(d.next_invoice.date) : "—"}` : d.cancel_at_period_end ? "None — plan ends at period end" : "—"} />
          <Row icon={CreditCard} label="Card on file" value={d.card || (d.can_open_portal ? "Add in Manage billing" : "—")} testid="plan-card-card" />
        </div>
        <div>
          <Row icon={Users} label="Team seats" value={d.usage ? `${d.usage.users} of ${q(d.quotas?.users)}` : "—"} testid="plan-card-seats" />
          <Row icon={Landmark} label="Bank accounts" value={d.usage ? `${d.usage.connected_accounts} of ${q(d.quotas?.connected_accounts)}` : "—"} testid="plan-card-accounts" />
        </div>
      </div>
      <div className="px-5 py-2.5 bg-slate-50 text-[11px] text-slate-500 border-t border-slate-100">
        Manage billing opens Stripe's secure portal — change plan (prorated), update your card, download invoices, or cancel at period end.
      </div>
    </div>
  );
}
