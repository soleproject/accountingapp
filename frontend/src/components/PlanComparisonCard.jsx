import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Check, Sparkles, X, Building2, Loader2 } from "lucide-react";

/**
 * Which plan is right for me? — side-by-side Free vs Paid comparison
 * used both as an inline card on ``/signup/enterprise`` (pre-signup
 * value prop) and as a modal inside ProSettings when an existing firm
 * owner clicks "Compare plans".
 *
 * Logged-in Pros: the Paid CTA POSTs to
 * ``/api/pro/branding/whitelabel-checkout`` which returns a Stripe
 * Checkout URL — we redirect straight to it. Logged-out visitors on
 * the signup page still see an inline "you can upgrade from Settings"
 * hint since we can't spin up a checkout without an authenticated pro.
 */
export default function PlanComparisonCard({
  variant = "card",   // "card" (inline) | "modal"
  onClose,            // required for variant="modal"
  loggedIn = false,   // toggles CTA behavior
  paidCurrent = false, // hide the CTA if the user is already on the paid tier
}) {
  const [busy, setBusy] = useState(false);
  // Pre-auth routes don't mount a Sonner <Toaster/>, so we render an
  // inline hint below the CTA instead of firing a toast that would be
  // silently dropped. Logged-in flows use toast normally.
  const [inlineHint, setInlineHint] = useState("");

  const clickPaidCta = async () => {
    if (!loggedIn) {
      setInlineHint("Create your firm below — you can upgrade from Settings any time.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post("/pro/branding/whitelabel-checkout", {
        origin_url: window.location.origin,
      });
      if (r.data?.already_unlocked) {
        toast.success("Your firm is already unlocked — reload to see white-label settings.");
        return;
      }
      if (r.data?.checkout_url) {
        window.location.href = r.data.checkout_url;
        return;
      }
      toast.error("Couldn't start checkout — no URL returned.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't start checkout");
    } finally {
      setBusy(false);
    }
  };

  const inner = (
    <div className="p-1" data-testid="plan-comparison-card">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={14} className="text-indigo-600" />
        <div className="text-xs uppercase tracking-widest text-indigo-700 font-semibold">
          Which plan is right for me?
        </div>
      </div>
      <div className="text-slate-500 text-xs mb-4">
        Everyone starts on Free. Turn on white-labeling when you're
        ready — your team, clients, and history come with you.
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <PlanTile
          name="Free"
          price="$0"
          priceHint="forever"
          accent="slate"
          highlight={paidCurrent === false}
          items={FREE_FEATURES}
          currentBadge={loggedIn && !paidCurrent}
          testId="plan-tile-free"
        />
        <PlanTile
          name="White-label"
          price="Upgrade"
          priceHint="unlock branding"
          accent="indigo"
          highlight={paidCurrent === true}
          items={PAID_FEATURES}
          currentBadge={loggedIn && paidCurrent}
          testId="plan-tile-paid"
          cta={paidCurrent ? null : (
            <>
              <button
                onClick={clickPaidCta}
                disabled={busy}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60"
                data-testid="plan-paid-cta"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {loggedIn ? "Unlock white-label — checkout" : "Learn more"}
              </button>
              {inlineHint && (
                <div
                  className="mt-2 text-[11px] text-slate-600 bg-indigo-50 border border-indigo-100 rounded px-2 py-1.5"
                  data-testid="plan-paid-hint"
                >
                  {inlineHint}
                </div>
              )}
            </>
          )}
        />
      </div>

      <div className="mt-4 text-[11px] text-slate-400 leading-relaxed">
        Upgrading is one click and doesn't touch your data. Downgrading
        keeps your firm intact and just puts the SmartBooks marks back.
      </div>
    </div>
  );

  if (variant === "modal") {
    return (
      <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden"
          data-testid="plan-comparison-modal"
        >
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-indigo-600" />
              <div className="font-semibold text-slate-800">Plans</div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700"
              data-testid="plan-modal-close"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{inner}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">{inner}</div>
  );
}

const FREE_FEATURES = [
  "Firm dashboard + client roster",
  "Unlimited firm-staff invites",
  "AI-assisted books for every client",
  "Journals, invoices, bills, reports",
  "Plaid + Veryfi integrations",
  "Affiliate + referral tracking",
];

const PAID_FEATURES = [
  { text: "Everything in Free", muted: true },
  "Private-label subdomain (yourfirm.accountingapp.ai)",
  "Custom login hero + tagline",
  "White-label outbound emails (no SmartBooks in footer)",
  "Custom favicon + browser tab name",
  "Hide sign-up link from your firm login",
  "Priority support",
];

function PlanTile({ name, price, priceHint, accent, highlight, items, cta, currentBadge, testId }) {
  const accentBg = accent === "indigo"
    ? "border-indigo-200 bg-gradient-to-b from-indigo-50/50 to-white"
    : "border-slate-200 bg-white";
  const priceColor = accent === "indigo" ? "text-indigo-700" : "text-slate-800";
  return (
    <div
      className={`rounded-lg border p-4 ${accentBg} ${highlight ? "ring-2 ring-offset-2 " + (accent === "indigo" ? "ring-indigo-400" : "ring-slate-300") : ""}`}
      data-testid={testId}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-heading font-bold text-slate-900">{name}</div>
        {currentBadge && (
          <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
            Current
          </span>
        )}
      </div>
      <div className={`mt-0.5 mb-3 flex items-baseline gap-1.5 ${priceColor}`}>
        <span className="text-2xl font-heading font-bold">{price}</span>
        <span className="text-[11px] text-slate-500">{priceHint}</span>
      </div>
      <ul className="space-y-1.5 text-sm text-slate-700 mb-3">
        {items.map((it, i) => {
          const t = typeof it === "string" ? it : it.text;
          const muted = typeof it !== "string" && it.muted;
          return (
            <li key={i} className={"flex items-start gap-2 " + (muted ? "text-slate-500" : "")}>
              <Check size={14} className={"mt-0.5 shrink-0 " + (accent === "indigo" ? "text-indigo-600" : "text-emerald-600")} />
              <span>{t}</span>
            </li>
          );
        })}
      </ul>
      {cta}
    </div>
  );
}
