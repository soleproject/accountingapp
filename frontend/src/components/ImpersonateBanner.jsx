// ImpersonateBanner — persistent top-bar shown whenever the current
// session was created via a superadmin "Open" action (see
// `openAsOwner` in ProClients.jsx). Reads a small metadata packet
// out of localStorage and offers a one-click "Stop impersonating"
// action that restores the original superadmin token + reloads.
//
// Zero-JS-cost when nobody's impersonating (returns null immediately).

import { toast } from "sonner";
import { LogOut, UserCog } from "lucide-react";

export default function ImpersonateBanner() {
  let target = null;
  try { target = JSON.parse(localStorage.getItem("axiom_impersonate_target") || "null"); }
  catch { target = null; }
  if (!target) return null;

  const stop = () => {
    const prevTok = localStorage.getItem("axiom_impersonate_prev_token");
    const prevUsr = localStorage.getItem("axiom_impersonate_prev_user");
    if (!prevTok || !prevUsr) {
      toast.error("Could not restore your superadmin session — please log in again.");
      // Fall back to full logout so the user isn't left in a limbo state.
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
      className="fixed top-0 left-0 right-0 z-[10000] bg-amber-500 text-slate-900 shadow-md flex items-center justify-between px-4 py-1.5"
      data-testid="impersonate-banner"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <UserCog size={15} />
        <span>
          Impersonating <b>{target.name}</b>
          {target.enterprise_name ? <> · <span className="text-slate-700">{target.enterprise_name}</span></> : null}
          <span className="ml-2 text-xs text-slate-800/80">({target.email})</span>
        </span>
      </div>
      <button
        onClick={stop}
        data-testid="impersonate-stop-btn"
        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium"
      >
        <LogOut size={12} /> Stop impersonating
      </button>
    </div>
  );
}
