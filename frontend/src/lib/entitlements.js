import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";

const Ctx = createContext(null);
const PREVIEW_KEY = "plan_preview";
export const PLAN_LABELS = { simple_start: "Core", assistant: "AI Assistant", bookkeeper: "AI Bookkeeper", advanced: "Advanced" };
export const PLAN_PRICE = { simple_start: 38, assistant: 79, bookkeeper: 99, advanced: 149 };
export const PLAN_ORDER = ["simple_start", "assistant", "bookkeeper", "advanced"];
export const PLAN_QUOTAS = {
  simple_start: { users: 1, connected_accounts: 3 },
  assistant: { users: 3, connected_accounts: 6 },
  bookkeeper: { users: 5, connected_accounts: null },
  advanced: { users: 5, connected_accounts: null },
};
export const QUOTA_COPY = {
  users: ["team members", "Add a seat"],
  connected_accounts: ["connected bank accounts", "Connect another account"],
};
export function nextPlanFor(kind, current, needed) {
  const i = PLAN_ORDER.indexOf(current);
  return PLAN_ORDER.slice(i + 1).find((p) => PLAN_QUOTAS[p][kind] == null || PLAN_QUOTAS[p][kind] >= needed) || null;
}
export const FEATURE_COPY = {
  quota_users: ["Team seats", "Invite more teammates to work in the books with you."],
  quota_connected_accounts: ["Connected bank accounts", "Link more bank and credit-card accounts for automatic imports."],
  chat: ["AI Review Chat", "Ask questions, review transactions and run commands from the side chat."],
  receipt_ai: ["AI Receipt Processing", "Snap a receipt and let the AI extract vendor, amount and line items."],
  outlook: ["AI Financial Outlook", "Plain-English readout, cash/burn/runway and forward projections."],
  checkins: ["AI Proactive Check-Ins", "The AI reaches out to the owner when it needs information."],
  statements_ai: ["AI Bank Statement Processing", "Upload statements for AI-assisted matching and review."],
  month_close: ["AI Month-End Close", "A guided monthly close so the books are always current."],
  bookkeeper_review: ["AI Bookkeeper Review", "Accuracy review and anomaly detection across your books."],
  liability_ai: ["Liability AI", "Automatic principal / interest / escrow splits on loan payments."],
  classes: ["Classes", "Track income and expenses across different areas of the business."],
  automations: ["AI Automations", "Set-and-forget rules the AI offers and executes for you."],
  auto_emails: ["AI Automations", "Automated reminders and follow-up emails."],
  bills_ai: ["AI Bill Processing", "Scan and process bills with AI."],
  adv_insights: ["Advanced AI Financial Insights", "Deeper pattern analysis across trends and opportunities."],
  adv_forecast: ["Advanced Forecasting", "Multi-scenario forecasting with what-if adjustments."],
  budgets: ["Budgeting", "Build and track budgets against actual performance."],
  inventory: ["Inventory", "Track inventory and its accounting impact."],
  sales_tax: ["Sales Tax Tracking", "Track sales tax collected and amounts owed."],
  reimbursements: ["Employee Reimbursement Tracking", "Track employee expenses and reimbursements."],
};

export function getPlanPreview() { return sessionStorage.getItem(PREVIEW_KEY) || "real"; }

export function EntitlementsProvider({ children }) {
  const { user } = useAuth();
  const { currentId } = useCompany();
  const [ent, setEnt] = useState(null);
  const [upgrade, setUpgrade] = useState(null); // {feature, ...payload}
  const [preview, setPreviewState] = useState(getPlanPreview());

  const load = useCallback(async () => {
    if (!user || !currentId) { setEnt(null); return; }
    try { setEnt((await api.get(`/companies/${currentId}/entitlements`)).data); }
    catch { setEnt(null); }
  }, [user, currentId]);
  useEffect(() => { load(); }, [load, preview]);

  const setPreview = (v) => {
    if (!v || v === "real") sessionStorage.removeItem(PREVIEW_KEY); else sessionStorage.setItem(PREVIEW_KEY, v);
    setPreviewState(v || "real");
  };

  // Frontend gates bite only when the backend enforces or a preview override is active.
  const active = !!ent && (ent.enforce || !!ent.preview);
  const can = useCallback((feature) => !active || !ent || ent.all_access || (ent.features || []).includes(feature), [active, ent]);
  const openUpgrade = useCallback((feature, extra = {}) => {
    const min_plan = ent?.min_plan?.[feature] || "assistant";
    setUpgrade({ feature, min_plan, min_plan_label: PLAN_LABELS[min_plan], min_plan_price: PLAN_PRICE[min_plan],
                 current_plan: ent?.plan, current_plan_label: ent?.plan_label, ...extra });
  }, [ent]);
  const openQuotaUpgrade = useCallback((kind) => {
    const used = ent?.usage?.[kind] ?? 0, limit = ent?.quotas?.[kind] ?? null;
    const nxt = nextPlanFor(kind, ent?.plan, used + 1);
    setUpgrade({ code: "quota_exceeded", feature: `quota_${kind}`, kind, used, limit,
                 current_plan: ent?.plan, current_plan_label: ent?.plan_label,
                 min_plan: nxt, min_plan_label: nxt ? PLAN_LABELS[nxt] : null, min_plan_price: nxt ? PLAN_PRICE[nxt] : null,
                 next_limit: nxt ? PLAN_QUOTAS[nxt][kind] : null });
  }, [ent]);

  useEffect(() => {
    const id = api.interceptors.response.use((r) => r, (err) => {
      const d = err?.response?.status === 402 ? err.response.data?.detail : null;
      if (d?.code === "upgrade_required" || d?.code === "quota_exceeded") setUpgrade(d);
      return Promise.reject(err);
    });
    return () => api.interceptors.response.eject(id);
  }, []);

  const value = useMemo(() => ({ ent, can, active, openUpgrade, openQuotaUpgrade, upgrade, closeUpgrade: () => setUpgrade(null), preview, setPreview, reload: load }),
    [ent, can, active, openUpgrade, openQuotaUpgrade, upgrade, preview, load]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlements() {
  return useContext(Ctx) || { ent: null, can: () => true, active: false, openUpgrade: () => {}, openQuotaUpgrade: () => {}, upgrade: null, closeUpgrade: () => {}, preview: "real", setPreview: () => {}, reload: () => {} };
}

// Seat / connected-account caps. `atCap` bites only when gating is active (enforce or preview);
// existing members/accounts are grandfathered — only NEW invites/connections are blocked.
export function useQuota(kind) {
  const { ent, active, openQuotaUpgrade, reload } = useEntitlements();
  const used = ent?.usage?.[kind] ?? 0;
  const limit = active ? (ent?.quotas?.[kind] ?? null) : null;
  return { used, limit, active: active && limit != null, atCap: limit != null && used >= limit, over: limit != null && used > limit,
           openUpgrade: () => openQuotaUpgrade(kind), reload };
}

export function useFeature(feature) {
  const { can, openUpgrade, ent } = useEntitlements();
  const allowed = can(feature);
  return { allowed, minPlan: ent?.min_plan?.[feature], openUpgrade: (extra) => openUpgrade(feature, extra) };
}
