// Reports gate for trialing clients: blurs the page behind a modal that
// explains Reports unlock with a paid plan and offers "Pay now" (ends
// the Stripe trial immediately) or "Wait for my trial to end".
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Loader2, CreditCard, CalendarClock, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

const money = (c) => (c == null ? "" : `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric" }) : "");

export default function TrialReportsGate({ children }) {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [state, setState] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (!currentId) return undefined;
    api.get(`/companies/${currentId}/billing/state`)
      .then((r) => { if (!cancelled) setState(r.data); })
      .catch(() => { if (!cancelled) setState({}); });
    return () => { cancelled = true; };
  }, [currentId]);

  const payNow = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/companies/${currentId}/billing/end-trial`);
      if (r.data?.sub_status === "active") {
        toast.success("Payment received — Reports are unlocked.");
        setState((s) => ({ ...s, trial_gate: false, trialing: false }));
      } else {
        setErr("Stripe is still confirming the payment. Give it a moment and refresh.");
      }
    } catch (e) {
      setErr(e.response?.data?.detail || "Payment failed. Please try again or update your card.");
    } finally {
      setBusy(false);
    }
  };

  const gated = !!state?.trial_gate;
  const days = state?.trial_end ? Math.max(0, Math.ceil((new Date(state.trial_end) - Date.now()) / 86400000)) : null;
  const per = state?.plan_cadence === "annual" ? "/yr" : "/mo";

  return (
    <div className="relative">
      <div className={gated ? "pointer-events-none select-none blur-[3px] opacity-60" : ""} aria-hidden={gated}>
        {children}
      </div>
      {gated && (
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-slate-900/30 backdrop-blur-[1px]" data-testid="trial-reports-gate">
          <div className="w-[min(520px,92vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl p-7">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-amber-600 font-semibold"><Lock size={13} /> Reports are part of your paid plan</div>
            <h3 className="font-heading text-xl font-bold text-slate-900 mt-1.5">Unlock Reports now, or at the end of your trial</h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              Your <b>{state.plan_label || "plan"}</b> free trial ends <b>{fmtDate(state.trial_end)}</b>{days != null ? ` (${days} day${days === 1 ? "" : "s"} left)` : ""}.
              Reports — P&amp;L, balance sheet, cash flow and tax summaries — switch on with your first payment.
            </p>
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Pay now</span>
                <span className="font-semibold text-slate-900">{money(state.plan_amount_cents)}{per}</span>
              </div>
              <div className="text-[12px] text-slate-500 mt-1">
                Charged today to {state.card || "your card on file"}. Your trial ends immediately and your {state.plan_cadence === "annual" ? "year" : "month"} starts today — nothing extra, no proration.
              </div>
            </div>
            {err && <div className="mt-3 text-[13px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2" data-testid="trial-gate-error">{err}</div>}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button onClick={payNow} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-md disabled:opacity-60" data-testid="trial-gate-pay-now">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />} Pay now &amp; unlock Reports
              </button>
              <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900 hover:border-slate-300" data-testid="trial-gate-wait">
                <CalendarClock size={14} /> I'll wait until {fmtDate(state.trial_end)}
              </button>
              <button onClick={() => navigate("/accounting/transactions")} className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" data-testid="trial-gate-back">
                <ArrowLeft size={12} /> Back to Transactions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
