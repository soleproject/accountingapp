// Cockpit access helper — mirrors backend `require_firm_or_pro`.
// Cockpit is a cross-client surface; single-book client-owners don't
// need it and the sidebar entry stays hidden for them.
//
// A subtle bug we hit in preview (Feb 2026): when `/auth/me` returned a
// stripped-down user payload during a backend redeploy, `user.role`
// briefly disappeared and the Cockpit link vanished until a hard
// refresh. Fix: cache the "firm-user" verdict in localStorage the first
// time we observe it and honor that cache when the fresh user object
// is missing role. The backend still enforces access via a 403 if the
// user isn't actually firm-level, so a stale cache never leaks data.
const FIRM_ROLES = new Set(["superadmin", "pro", "admin", "partner"]);
const CACHE_KEY = "axiom_is_firm_user";

export function canUseCockpit(user) {
  if (!user) return false;
  const role = (user.role || "").toLowerCase();
  if (FIRM_ROLES.has(role)) {
    // Remember for the session so a transient role-less payload
    // doesn't hide the link.
    try { localStorage.setItem(CACHE_KEY, "1"); } catch {}
    return true;
  }
  // Role explicitly known and NOT a firm role → hide.
  if (role) {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    return false;
  }
  // Role missing (transient) → honor last-known verdict.
  try { return localStorage.getItem(CACHE_KEY) === "1"; } catch { return false; }
}
