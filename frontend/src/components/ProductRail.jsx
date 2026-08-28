import { Link, useLocation } from "react-router-dom";
import {
  Calculator, Users, Building2, Briefcase, Sparkles,
} from "lucide-react";

import { useCompany } from "@/lib/company";

/**
 * Product rail — the 60px-wide left-most bar that lets users jump
 * between the four products of the platform:
 *
 *   • Accounting — the GL/reports (existing surface)
 *   • CRM        — sales pipeline, leads, deals (coming in Phase C)
 *   • Team       — employees, tasks, calendar (coming in Phase B)
 *   • Projects   — job costing (promoted here from accounting nav)
 *
 * The active product is derived from the URL prefix so deep-links
 * always land in the right context. Sidebar reads the same detector
 * (`detectProduct`) to swap its nav groups. Product colors are
 * applied consistently as the active-state accent so a user always
 * knows which product they're in.
 */
const PRODUCTS = [
  {
    key: "accounting", label: "Accounting", icon: Calculator,
    to: "/dashboard", color: "cyan",
  },
  {
    key: "crm", label: "CRM", icon: Users,
    to: "/crm", color: "violet",
  },
  {
    key: "team", label: "Team", icon: Building2,
    to: "/team", color: "emerald",
  },
  {
    key: "projects", label: "Projects", icon: Briefcase,
    to: "/accounting/projects", color: "amber",
    projectsEnabledOnly: true,
  },
];

/**
 * Given a location object, return the active product key. Order
 * matters — "/accounting/projects" must match projects before it
 * matches the generic accounting fallback. Query-string
 * `?product=<key>` overrides the URL prefix so a cross-product
 * link (CRM → /contacts, which lives under Accounting) can pin
 * itself to a specific product shell instead of flipping the
 * sidebar.
 */
export function detectProduct(pathname, search = "") {
  try {
    const params = new URLSearchParams(search);
    const override = params.get("product");
    if (override && ["accounting", "crm", "team", "projects"].includes(override)) {
      return override;
    }
  } catch { /* ignore malformed search */ }
  if (pathname.startsWith("/crm")) return "crm";
  if (pathname.startsWith("/team")) return "team";
  if (pathname.startsWith("/accounting/projects")) return "projects";
  return "accounting";
}

// Static color classes keyed by product — dynamic Tailwind strings
// get purged by the JIT, so each variant is spelled out below.
const ACTIVE_STYLES = {
  cyan:    "bg-cyan-50 text-cyan-700 border-cyan-500",
  violet:  "bg-violet-50 text-violet-700 border-violet-500",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-500",
  amber:   "bg-amber-50 text-amber-700 border-amber-500",
};

export default function ProductRail() {
  const loc = useLocation();
  const { projectsEnabled } = useCompany();
  const active = detectProduct(loc.pathname, loc.search);

  const products = PRODUCTS.filter(
    (p) => !p.projectsEnabledOnly || projectsEnabled);

  return (
    <nav data-testid="product-rail"
          className="w-[60px] shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-3 gap-1 relative z-[1000]"
          aria-label="Products">
      {products.map((p) => {
        const isActive = active === p.key;
        const Icon = p.icon;
        const isComingSoon = p.key === "crm" || p.key === "team";
        return (
          <Link key={p.key} to={p.to}
                data-testid={`product-rail-${p.key}`}
                title={`${p.label}${isComingSoon ? " (preview)" : ""}`}
                className={`w-11 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 transition relative border-l-2 ${
                  isActive
                    ? ACTIVE_STYLES[p.color] + " shadow-sm"
                    : "border-transparent text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}>
            <Icon size={16} />
            <span className="text-[8px] uppercase tracking-wider leading-none font-semibold">
              {p.label}
            </span>
            {isComingSoon && !isActive && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 border border-slate-900"
                    title="Preview / Coming soon" />
            )}
          </Link>
        );
      })}
      <div className="mt-auto">
        <div className="text-[8px] uppercase tracking-wider text-slate-600 rotate-180"
              style={{ writingMode: "vertical-rl" }}>
          <Sparkles size={9} className="inline mb-1" /> AI-native
        </div>
      </div>
    </nav>
  );
}
