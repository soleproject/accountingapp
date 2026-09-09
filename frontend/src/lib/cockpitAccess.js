// Cockpit access helper — mirrors backend `require_firm_or_pro`.
// Cockpit is a cross-client surface; single-book client-owners don't
// need it and the sidebar entry stays hidden for them.
export function canUseCockpit(user) {
  if (!user) return false;
  const role = (user.role || "").toLowerCase();
  const firmRoles = new Set(["superadmin", "pro", "admin", "partner"]);
  return firmRoles.has(role);
}
