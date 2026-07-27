// ImpersonatePill — compact amber chip in the topbar that appears
// whenever the current session was created via a superadmin "Open"
// action on the Enterprises grid. Reads the metadata packet dropped
// in localStorage by `openAsOwner` (see `ProClients.jsx`) and offers
// a one-click "Stop" that restores the previously-stashed superadmin
// token + user shape and reloads back to `/pro/clients`.
//
// Zero-JS-cost when nobody's impersonating (returns null immediately).

import { toast } from "sonner";
import { LogOut, UserCog } from "lucide-react";

export default function ImpersonatePill() {
  let target = null;
  try { target = JSON.parse(localStorage.getItem("axiom_impersonate_target") || "null"); }
  catch { target = null; }
  if (!target) return null;

  const stop = () => {
    const prevTok = localStorage.getItem("axiom_impersonate_prev_token");
    const prevUsr = localStorage.getItem("axiom_impersonate_prev_user");
    if (!prevTok || !prevUsr) {
      toast.error("Could not restore your superadmin session — please log in again.");
      localStorage.removeItem("axiom_token");
      localStorage.removeItem("axiom_user");
      window.location.href = "/login";
      return;
    }
    localStorage.setItem("axiom_token", prevTok);
    localStorage.setItem("axiom_user", prevUsr);
    localStorage.removeItem("axiom_impersonate_prev_token");
    localStorage.removeItem("axiom_impersonate_prev_user");
    localStorage.removeItem("axiom_impersonate_target");
    localStorage.removeItem("axiom_company_id");
    window.location.href = "/pro/clients";
  };

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-amber-100 border border-amber-300 pl-2.5 pr-1 py-1 text-xs text-amber-900 shadow-sm max-w-[380px]"
      data-testid="impersonate-pill"
    >
      <UserCog size={13} className="text-amber-700 shrink-0" />
      <span className="truncate">
        Viewing as <b className="font-semibold">{target.name}</b>
        {target.enterprise_name ? (
          <span className="text-amber-700"> · {target.enterprise_name}</span>
        ) : null}
      </span>
      <button
        onClick={stop}
        data-testid="impersonate-stop-btn"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-medium shrink-0"
        title={`Restore superadmin session (was impersonating ${target.email || "this user"})`}
      >
        <LogOut size={11} /> Stop
      </button>
    </div>
  );
}
