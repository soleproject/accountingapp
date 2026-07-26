// -----------------------------------------------------------------------
// BillingReturn — landing pages for Stripe Checkout redirects.
//   /billing/success?session_id=cs_test_...&company_id=...
//   /billing/cancel?company_id=...
//
// success: polls /companies/{cid}/billing/state until it flips to
// `active` (the webhook may take a few seconds) then routes into the
// dashboard for that company.
// cancel: shows a friendly "no charge posted" message with a "Try again"
// button that re-opens the checkout session.
// -----------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { CheckCircle2, Loader2, XCircle, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export function BillingSuccess() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { switchCompany } = useCompany();
  const cid = params.get("company_id");
  const [state, setState] = useState("polling"); // polling | active | timeout
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await api.get(`/companies/${cid}/billing/state`);
        if (cancelled) return;
        if (r.data?.billing_state === "active") {
          setState("active");
          // small delay so the user sees the ✓ before we redirect
          setTimeout(() => {
            switchCompany(cid);
            nav("/dashboard");
          }, 1500);
        } else {
          setTries((n) => n + 1);
        }
      } catch { /* keep polling — webhook may still be en route */ }
    };
    poll();
    const t = setInterval(poll, 2000);
    // Give up after 30s and let the user in anyway — the webhook may
    // arrive minutes later depending on Stripe latency.
    const giveUp = setTimeout(() => { if (!cancelled) setState("timeout"); }, 30_000);
    return () => { cancelled = true; clearInterval(t); clearTimeout(giveUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
        {state === "active" ? (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 size={26} className="text-emerald-600" />
            </div>
            <h1 className="mt-4 font-heading text-2xl font-bold">Payment confirmed ✨</h1>
            <p className="mt-2 text-sm text-slate-600">Redirecting to the dashboard…</p>
          </>
        ) : state === "timeout" ? (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center">
              <Loader2 size={26} className="text-amber-600" />
            </div>
            <h1 className="mt-4 font-heading text-2xl font-bold">Payment received — finalizing…</h1>
            <p className="mt-2 text-sm text-slate-600">
              Stripe is taking longer than usual to send us the confirmation.
              You can continue — access will unlock automatically the moment it arrives.
            </p>
            <button
              onClick={() => { if (cid) switchCompany(cid); nav("/dashboard"); }}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm"
            >
              Continue to dashboard <ArrowRight size={13} />
            </button>
          </>
        ) : (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center">
              <Loader2 size={26} className="text-slate-500 animate-spin" />
            </div>
            <h1 className="mt-4 font-heading text-2xl font-bold">Confirming payment…</h1>
            <p className="mt-2 text-sm text-slate-600">
              Waiting for Stripe to send us the receipt. Poll #{tries + 1}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}


export function BillingCancel() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const cid = params.get("company_id");
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${cid}/billing/checkout-session`, {
        origin_url: window.location.origin,
      });
      if (r.data?.checkout_url) window.location.href = r.data.checkout_url;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not reopen Stripe checkout");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center">
          <XCircle size={26} className="text-slate-500" />
        </div>
        <h1 className="mt-4 font-heading text-2xl font-bold">Checkout canceled</h1>
        <p className="mt-2 text-sm text-slate-600">
          No charge was posted. The company is still blocked from access
          until a payment goes through.
        </p>
        <div className="mt-5 flex gap-2 justify-center">
          {cid && (
            <button
              onClick={retry}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-60"
              data-testid="billing-cancel-retry"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              Try payment again
            </button>
          )}
          <button
            onClick={() => nav("/pro/clients")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-300 text-slate-700 text-sm"
          >
            Back to Clients
          </button>
        </div>
      </div>
    </div>
  );
}
