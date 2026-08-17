// DemoVisitorPill — indigo chip in the topbar shown ONLY when the
// current session was minted via the public /demo/uk endpoint (see
// `pages/PublicDemoUK.jsx`). Serves two goals:
//   1. Tells the visitor they're in a read-only demo so a write
//      attempt that 403s doesn't feel like a broken button.
//   2. Wraps a hard signup CTA — this is the primary conversion
//      surface for cold UK marketing traffic landing on /demo/uk.
//
// Reads `axiom_user.is_demo_visitor` — the public-demo endpoint sets
// this flag when it mints the token. Zero-JS-cost when the visitor
// is a normal signed-in user (returns null immediately).

import { Sparkles, ArrowRight } from "lucide-react";

export default function DemoVisitorPill() {
  let user = null;
  try { user = JSON.parse(localStorage.getItem("axiom_user") || "null"); }
  catch { user = null; }
  if (!user?.is_demo_visitor) return null;

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-indigo-100 border border-indigo-300 pl-2.5 pr-1 py-1 text-xs text-indigo-900 shadow-sm max-w-[380px]"
      data-testid="demo-visitor-pill"
    >
      <Sparkles size={13} className="text-indigo-700 shrink-0" />
      <span className="truncate">
        <b className="font-semibold">Live UK demo</b>
        <span className="text-indigo-700"> · read-only</span>
      </span>
      <a
        href="/signup"
        data-testid="demo-visitor-signup-cta"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-medium shrink-0"
        title="Sign up for your own SmartBooks account with full edit access"
      >
        Sign up <ArrowRight size={11} />
      </a>
    </div>
  );
}
