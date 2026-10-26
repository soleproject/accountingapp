import { useEffect, useState } from "react";
import { api } from "@/lib/api";

let cache = null, inflight = null;
const listeners = new Set();
const load = () => {
  if (!inflight) inflight = api.get("/practice/me").then(r => { cache = r.data; listeners.forEach(l => l(cache)); return cache; }).catch(() => { cache = { permissions: null }; return cache; }).finally(() => { inflight = null; });
  return inflight;
};
export const resetPracticePerms = () => { cache = null; };

export const canDo = (perms, feature, action = "view") => {
  if (!perms) return true;
  const f = perms[feature] || {};
  if (action === "view") return !!(f.view || f.view_all);
  if (action === "edit") return !!(f.edit || f.edit_all);
  return !!f[action];
};

export const FEATURE_BY_ROUTE = [
  ["/practice/contacts", "Contacts"], ["/practice/matters", "Matters"], ["/practice/calendar", "Activities (Tasks, Events & Calls)"], ["/practice/activities", "Activities (Tasks, Events & Calls)"], ["/practice/workflows", "Activities (Tasks, Events & Calls)"], ["/practice/time-entries", "Time Entries"],
  ["/practice/expenses", "Expenses"], ["/practice/invoices", "Invoices"], ["/practice/payments/accounts", "Bank Accounts"], ["/practice/payments/reconciliation", "Bank Accounts"],
  ["/practice/payments/print-checks", "Firm Payments"], ["/practice/checks", "Firm Payments"], ["/practice/payments", "Contact Payments"], ["/practice/roles", "Roles"],
  ["/practice/users/new", "Users & User Groups"],
];
export const featureForPath = (p) => (FEATURE_BY_ROUTE.find(([r]) => p === r || p.startsWith(r + "/") ) || [])[1] || null;

export function usePracticePerms() {
  const [me, setMe] = useState(cache);
  useEffect(() => {
    if (cache) { setMe(cache); return; }
    const l = (v) => setMe(v);
    listeners.add(l); load();
    return () => listeners.delete(l);
  }, []);
  return { me, loaded: !!me, can: (feature, action) => canDo(me?.permissions, feature, action) };
}

export const Can = ({ feature, action = "view", children, fallback = null }) => {
  const { can } = usePracticePerms();
  return can(feature, action) ? children : fallback;
};
