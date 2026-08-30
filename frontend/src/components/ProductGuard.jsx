/**
 * ProductGuard — gates access to a product's route based on
 * `me.enabled_products` returned by the backend. Superadmins bypass
 * (backend already includes every product in their list).
 *
 * Behavior:
 *  - Not authenticated → let the app's normal auth flow handle it
 *    (this component doesn't re-implement auth redirects).
 *  - Home + only 1 module → soft-redirect to `default_landing`.
 *  - Locked module → show a friendly "Preview only" screen with a
 *    button back to the default landing, rather than dumping the
 *    user on a 403 or a blank page.
 *
 * Usage: <ProductGuard product="crm"><CrmOverview /></ProductGuard>
 */
import { Navigate, Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Sparkles, ArrowRight } from "lucide-react";

const PRODUCT_LABEL = {
  crm: "CRM",
  projects: "Projects",
  team: "Team",
  accounting: "Accounting",
};

export default function ProductGuard({ product, children }) {
  const { user, loading } = useAuth();
  if (loading || !user) return children;  // let auth wiring handle it
  const enabled = user.enabled_products || [];
  const showHome = !!user.show_home;
  const landing = user.default_landing || "/dashboard";

  // Home is a router — hide it (redirect) when the user has < 2
  // modules. Superadmins always have >= 4, so this never fires for them.
  if (product === "home" && !showHome) {
    return <Navigate to={landing} replace />;
  }
  // Non-home, gated product not in the user's list — show the
  // preview-only screen.
  if (product !== "home" && !enabled.includes(product)) {
    return (
      <div className="max-w-xl mx-auto mt-20 rounded-2xl border border-slate-200 bg-white p-8 text-center"
            data-testid={`product-guard-${product}`}>
        <div className="w-12 h-12 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center mx-auto mb-4">
          <Sparkles size={20} />
        </div>
        <h1 className="text-xl font-heading font-bold text-slate-900">
          {PRODUCT_LABEL[product] || product} is in preview
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          We're polishing this product with a small group of early
          testers. It'll show up in your sidebar automatically once
          we open it up.
        </p>
        <Link to={landing} data-testid={`product-guard-${product}-back`}
              className="inline-flex items-center gap-1.5 mt-6 px-4 py-2 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-sm">
          Back to your workspace <ArrowRight size={14} />
        </Link>
      </div>
    );
  }
  return children;
}
