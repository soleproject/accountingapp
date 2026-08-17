import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Loader2 } from "lucide-react";

/**
 * Public "Live UK demo" landing.
 *
 * Anyone hitting `/demo/uk` gets auto-logged-in as a read-only visitor
 * on Northgate Advisory Ltd — no signup, no card, no friction. Backend
 * mints a 30-min viewer JWT via `POST /api/public/demo/uk`, we stash
 * it in localStorage exactly like a normal login, then push into
 * `/dashboard` so the visitor lands on a fully-populated FRS 102 UK
 * ledger.
 *
 * Renders a tasteful loading state (not a bare spinner) because this
 * IS the first impression for cold UK marketing traffic.
 */
export default function PublicDemoUK() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.post("/public/demo/uk");
        if (cancelled) return;
        const { token, user, company_id, banner } = r.data;
        // Mirror the normal login flow so every other component
        // (Auth provider, CompanyProvider) picks up the session.
        localStorage.setItem("axiom_token", token);
        localStorage.setItem("axiom_user", JSON.stringify(user));
        localStorage.setItem("axiom_company_id", company_id);
        localStorage.setItem("axiom_demo_banner", banner || "");
        // Full navigation so the app re-hydrates the auth context
        // from localStorage — same pattern as the impersonation flow.
        window.location.href = "/dashboard";
      } catch (e) {
        if (cancelled) return;
        setError(e.response?.data?.detail || e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6"
      data-testid="public-demo-uk-landing"
    >
      <div className="max-w-lg text-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white mb-6">
          🇬🇧 Live Demo · United Kingdom
        </div>
        <h1 className="font-heading text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
          Opening Northgate Advisory Ltd…
        </h1>
        <p className="mt-4 text-base text-slate-600">
          A real, read-only UK Ltd company on SmartBooks — FRS 102 chart of accounts,
          VAT-coded invoices, statutory Balance Sheet.
          <br className="hidden sm:block" />
          You'll be looking at genuine software in about a second.
        </p>
        {!error ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Preparing your session…</span>
          </div>
        ) : (
          <div
            className="mt-8 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            data-testid="public-demo-uk-error"
          >
            <div className="font-semibold mb-1">Couldn't open the demo</div>
            <div className="text-xs">{error}</div>
            <button
              className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
              onClick={() => window.location.reload()}
              data-testid="public-demo-uk-retry"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
