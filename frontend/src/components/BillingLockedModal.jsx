// -----------------------------------------------------------------------
// BillingLockedModal — full-screen blocking modal that appears whenever
// the currently-selected company's `billing_state` is not `active` or
// `pending`. Renders as a portal so it sits above every route content
// component. The only action available is "Pay now" which calls the
// company checkout-session endpoint and redirects the browser to Stripe.
//
// Wired from `Layout.jsx` — it polls the state once per page load + once
// per companyId change, and refetches every 20s while `locked=true` so
// the modal auto-dismisses within seconds of the webhook flipping state
// back to active.
// -----------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { Lock, Loader2, CreditCard } from "lucide-react";
import { toast } from "sonner";

const POLL_MS = 20_000;

export default function BillingLockedModal() {
  const { currentId } = useCompany();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);

  const fetchState = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/billing/state`);
      setState(r.data);
    } catch {
      // Silent — a 404 here just means the user has no access; the
      // rest of the app will already have redirected them.
      setState(null);
    }
  };

  // Re-fetch on companyId change + short-poll while locked.
  useEffect(() => {
    fetchState();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (state?.locked) fetchState();
    }, POLL_MS);
    return () => timerRef.current && clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, state?.locked]);

  const payNow = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/billing/checkout-session`, {
        origin_url: window.location.origin,
      });
      if (r.data?.checkout_url) {
        window.location.href = r.data.checkout_url;
      } else {
        toast.error("Stripe returned no checkout URL — check Communications.");
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to open Stripe checkout");
    } finally {
      setBusy(false);
    }
  };

  if (!state?.locked) return null;

  const stateLabel =
    state.billing_state === "past_due"  ? "Past due"
    : state.billing_state === "canceled" ? "Canceled"
    : state.billing_state === "unpaid"   ? "Unpaid"
    : state.billing_state;

  return (
    <div
      className="fixed inset-0 z-[999] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4"
      data-testid="billing-locked-modal"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 text-center">
        <div className="w-14 h-14 mx-auto rounded-full bg-rose-100 flex items-center justify-center">
          <Lock size={22} className="text-rose-600" />
        </div>
        <h2 className="mt-4 font-heading text-2xl font-bold text-slate-900">
          Payment needed to keep the books open
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          This company's subscription is <b className="text-rose-700">{stateLabel}</b>.
          Nobody — pro or client — can open the ledger until it's paid.
        </p>

        <div className="mt-4 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 text-left">
          <div className="flex justify-between">
            <span className="text-slate-500">Product</span>
            <span className="font-mono-num text-slate-700">
              {state.billing_product || "—"}{state.billing_discount ? " · disc" : ""}
            </span>
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-slate-500">Payer</span>
            <span className="font-mono-num text-slate-700">{state.billing_payer || "—"}</span>
          </div>
        </div>

        {!state.stripe_configured && (
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 text-left">
            <b>Stripe not configured on this environment.</b>{" "}
            Once STRIPE_SECRET_KEY is set + the app redeployed, the Pay button will open a real Checkout page.
          </div>
        )}

        <button
          onClick={payNow}
          disabled={busy || !state.stripe_configured}
          data-testid="billing-locked-pay-btn"
          className="mt-5 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 w-full"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
          {busy ? "Opening Stripe…" : "Pay now →"}
        </button>
        <div className="mt-3 text-[11px] text-slate-400">
          Your access will re-open automatically the moment Stripe confirms the payment.
        </div>
      </div>
    </div>
  );
}
