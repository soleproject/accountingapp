/**
 * Todo2CardList — the sidebar's "cards mode" for the To Do 2 link.
 * Renders one clickable card per still-open item from the same
 * `/companies/{cid}/responsibilities/status` endpoint the /accounting/todo
 * page uses, so the sidebar cards mirror the page 1:1.
 *
 * Each card deep-links to the exact place the task lives — either an
 * `area_link` page (bills, invoices, receipts, …) OR back onto the
 * To Do page anchored at that section, so the CPA lands where they
 * can act. `return_to` + `return_label` query params ride along so
 * the target page can show a breadcrumb back to the sidebar view.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { canUseCockpit } from "@/lib/cockpitAccess";
import { useEntitlements } from "@/lib/entitlements";
import { Lock as LockIcon } from "lucide-react";
import { useUserPref } from "@/hooks/useUserPref";
import { reviewEta, reviewMinutes } from "@/components/DashboardTodos";
import {
  ArrowLeft, Loader2, ChevronRight, ChevronDown, CircleAlert, User, Bot, Wrench,
  LayoutDashboard, FileText, Receipt, ArrowLeftRight, ScrollText, BarChart3, Compass,
  ListTree, Building2, Wallet, Boxes, Tags, CheckCheck, Printer, BookOpen,
  Notebook, Percent, Sparkles, Wand2, ClipboardCheck, CalendarCheck, Lock, History,
  // Icons for the nested Sales & Payments / Purchases subgroups on
  // the Both-tab accordion (mirrors the Full-mode Sidebar icons).
  CreditCard, Package, Repeat, MailCheck, UserCircle, Store, ShoppingCart,
  // Icons for CPA-workflow items promoted into the All accordion
  // (Contacts, Projections, Compliance, Email log, Connect & Import
  // subgroup, and the trailing Accounting settings leaf). Kept in
  // one dedicated group so it's obvious where to add more later.
  Users, TrendingUp, ShieldCheck, Inbox,
  Landmark, Link2, Download, Settings2,
  // Icons for the firm-only Professional section (Today + Client
  // Cockpit) added below the All accordion for pros/superadmins.
  // Extra icons (Shield/Briefcase/Rocket) power the Superadmin-flavor
  // of that same section — see isSuperadmin branch below.
  Sunrise, Activity, Shield, Briefcase, Rocket,
  MoreHorizontal, Share2,
} from "lucide-react";

// "More" — sits directly under the "All" accordion. Mirrors the Full
// sidebar's bottom group (My Businesses, Billing, Refer & earn,
// Settings) and shares its persisted open-state key.
const MORE_LINKS = [
  { to: "/my-businesses", label: "My Businesses", icon: Briefcase },
  { to: "/billing",       label: "Billing",       icon: CreditCard },
  { to: "/share",         label: "Refer & earn",  icon: Share2 },
];

// Sidebar-card label overrides — shorter, action-oriented names that
// fit a rail-width column. Keep the mapping tight so a new catalog
// entry falls back to `item.label` on the backend if we forget it here.
const CARD_LABELS = {
  monitoring_cash_flow:        "Cash Flow",
  reviewing_transactions:      "Transactions",
  paying_bills:                "Bills",
  following_up_invoices:       "Invoices",
  monitoring_inventory:        "Inventory",
  issuing_payroll:             "Payroll",
  reconciling_accounts:        "Reconcile",
  paying_sales_tax:            "Sales Tax",
  eom_closing:                 "Close",
  paying_payroll_liabilities:  "Payroll Liabilities",
  liability_payments:          "Liability Payments",
  checks_no_payee:             "Checks",
  receipt_followup:            "Receipts",
  irs_compliance:              "IRS",
  ai_auto_cleanup:             "AI Cleanup",
};

// Explicit sort order matching the CPA's mental model:
// cash first (survival), receivables + payables (working capital),
// inventory + core-cleanup (bookkeeping loop), then obligations
// (compliance/reconcile/close). Anything not in this map sinks to
// the bottom so a brand-new catalog entry is still discoverable.
const CARD_ORDER = [
  "monitoring_cash_flow",
  "following_up_invoices",
  "paying_bills",
  "monitoring_inventory",
  "reviewing_transactions",
  "liability_payments",
  "checks_no_payee",
  "receipt_followup",
  "irs_compliance",
  "issuing_payroll",
  "reconciling_accounts",
  "paying_sales_tax",
  "eom_closing",
];

// Tier mapping — same three-tier model the Cockpit uses.
// ai = things the AI can (or should) still resolve on its own → 🟢
// assistant = light-touch, delegate-able → 🟣
// pro = needs CPA judgment → 🟡 (default for everything tracked)
const TIER = {
  monitoring_cash_flow:      { tier: "pro",       label: "Professional" },
  reviewing_transactions:    { tier: "ai",        label: "AI Junior" },
  paying_bills:              { tier: "assistant", label: "Assistant" },
  following_up_invoices:     { tier: "assistant", label: "Assistant" },
  monitoring_inventory:      { tier: "assistant", label: "Assistant" },
  issuing_payroll:           { tier: "pro",       label: "Professional" },
  reconciling_accounts:      { tier: "pro",       label: "Professional" },
  paying_sales_tax:          { tier: "pro",       label: "Professional" },
  paying_payroll_liabilities:{ tier: "pro",       label: "Professional" },
  eom_closing:               { tier: "pro",       label: "Professional" },
  liability_payments:        { tier: "assistant", label: "Assistant" },
  checks_no_payee:           { tier: "assistant", label: "Assistant" },
  receipt_followup:          { tier: "assistant", label: "Assistant" },
  irs_compliance:            { tier: "pro",       label: "Professional" },
  ai_auto_cleanup:           { tier: "ai",        label: "AI Junior" },
};
const TIER_STYLES = {
  ai:        { border: "border-l-emerald-400", bg: "bg-emerald-50/40", chip: "text-emerald-700 bg-emerald-100", Icon: Bot },
  assistant: { border: "border-l-indigo-400",  bg: "bg-indigo-50/40",  chip: "text-indigo-700 bg-indigo-100",   Icon: User },
  pro:       { border: "border-l-amber-400",   bg: "bg-amber-50/40",   chip: "text-amber-800 bg-amber-100",     Icon: Wrench },
};

// Sort priority: pro → assistant → ai (only-you-can-do-it first).
const TIER_ORDER = { pro: 0, assistant: 1, ai: 2 };

// Per-catalog filter params so the destination page opens ALREADY
// scoped to the items the card represents. If a page doesn't accept
// a filter, the entry stays null and the page opens unfiltered.
// Quick Check-in buckets that open the live check-in in-shell, scoped
// to their item types (see pages/EmbeddedCheckin.jsx CHECKIN_SCOPES).
const EMBEDDED_CHECKIN_ROUTES = {
  liability_payments:         "/accounting/liability-payments",
  cleanup_liability_payments: "/accounting/liability-payments",
  receipt_followup:           "/accounting/receipt-followup",
  cleanup_receipt_followup:   "/accounting/receipt-followup",
  // Checks open the Review Chat "Checks" tab (payee + category allocator).
  checks_no_payee:            "/accounting/review-chat?tab=checks",
  cleanup_checks_no_payee:    "/accounting/review-chat?tab=checks",
};

const CARD_FILTERS = {
  paying_bills:          { overdue: "1" },       // /bills — past-due only
  following_up_invoices: { overdue: "1" },       // /invoices — past-due only
  reconciling_accounts:  { filter: "unreconciled" }, // /accounting/reconciliation
};

const _buildOpenHref = (href, returnTo, returnLabel, extraParams = {}) => {
  if (!href) return null;
  const params = new URLSearchParams();
  // Filter params first — they belong to the target page.
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  }
  if (returnTo)    params.set("return_to", returnTo);
  if (returnLabel) params.set("return_label", returnLabel);
  const qs = params.toString();
  if (!qs) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}${qs}`;
};

// Quick-nav strip shown above the first card in expanded To Do 2
// mode. Same routes surfaced elsewhere in the sidebar — repeated
// here so the CPA doesn't have to bounce back to the full menu
// just to jump into Invoices/Bills/etc. while triaging tasks.
const QUICK_LINKS = [
  { to: "/owner",                 label: "My business",  icon: Compass },
  { to: "/dashboard",             label: "Dashboard",    icon: LayoutDashboard },
  { to: "/invoices",              label: "Invoices",     icon: FileText },
  { to: "/bills",                 label: "Bills",        icon: Receipt },
  { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/receipts",              label: "Receipts",     icon: ScrollText },
  { to: "/reports",               label: "Reports",      icon: BarChart3 },
];

// Full Accounting submenu — same routes as the "All" section of the
// sidebar's Full mode, exposed here as a collapsible accordion so
// the CPA can dive into ledger tools without leaving cards mode.
// Kept in sync manually with the master list in Sidebar.jsx.
//
// Note: the standalone `Transactions` link that used to live at the
// top of this list is intentionally removed — it's already covered
// by the QUICK_LINKS strip above, so keeping it here surfaced the
// same page twice in a row.
const SALES_LINKS = [
  { to: "/estimates",                     label: "Estimates",           icon: FileText },
  { to: "/invoices",                      label: "Invoices",            icon: FileText },
  { to: "/payments?direction=in",         label: "Payments",            icon: CreditCard },
  { to: "/items?usage=sales",             label: "Products & Services", icon: Package },
  { to: "/recurring",                     label: "Recurring",           icon: Repeat },
  { to: "/customer-statements",           label: "Customer Statements", icon: MailCheck },
  { to: "/contacts?type=customer",        label: "Customers",           icon: UserCircle },
];
const PURCHASES_LINKS = [
  { to: "/purchase-orders",               label: "Purchase Orders",     icon: FileText },
  { to: "/bills",                         label: "Bills",               icon: Receipt },
  { to: "/payments?direction=out",        label: "Payments",            icon: CreditCard },
  { to: "/payments?type=cc",              label: "Credit Card Payments",icon: CreditCard },
  { to: "/items?usage=purchases",         label: "Items",               icon: Package },
  { to: "/contacts?type=vendor",          label: "Vendors",             icon: Store },
];
// Connect & Import subgroup — same routes as the top-level Banking
// group in Sidebar.jsx (minus Test QBO which is superadmin-only).
const CONNECT_LINKS = [
  { to: "/connections",             label: "Connect Accounts",   icon: Link2 },
  { to: "/connections?view=imports", label: "Import Statements", icon: Download },
  { to: "/connections/qbo",         label: "Connect QBO",        icon: Link2 },
];
const ACCOUNTING_LINKS = [
  // ── Grouped view (Sept 2026) ─────────────────────────────────────
  // Items are organized under section headers so the CPA can scan the
  // menu vertically by workflow area. Headers are non-clickable rows
  // rendered by AccountingAccordion via the `header: true` flag.
  // Nested subgroups (Sales & Payments, Purchases, Connect & Import)
  // keep the same `subGroup: true` inline-collapsible behavior.
  { header: true,  label: "Sales & Money" },
  { subGroup: true, key: "sales",     label: "Sales & Payments", icon: FileText,     items: SALES_LINKS },
  { subGroup: true, key: "purchases", label: "Purchases",        icon: ShoppingCart, items: PURCHASES_LINKS },
  { to: "/accounting/loans",              label: "Loans",              icon: Wallet },
  { to: "/accounting/assets",             label: "Assets",             icon: Building2 },
  { to: "/inventory-management",          label: "Inventory",          icon: Boxes, feature: "inventory" },
  { to: "/accounting/sales-tax",          label: "Sales Tax Center",   icon: Percent, feature: "sales_tax" },

  { header: true, label: "Accounting" },
  { to: "/accounting/chart-of-accounts",  label: "Chart of Accounts",  icon: ListTree },
  { to: "/accounting/reconciliation",     label: "Reconciliation",     icon: CheckCheck },
  { to: "/accounting/journal-entries",    label: "Journal Entries",    icon: BookOpen },
  { to: "/accounting/general-ledger",     label: "General Ledger",     icon: Notebook },
  { to: "/accounting/checks",             label: "Print Checks",       icon: Printer },
  { to: "/accounting/tags",               label: "Tags",               icon: Tags },

  { header: true, label: "AI & Automation" },
  { to: "/accounting/ai-cleanup-review",  label: "AI Cleanup Review",  icon: Sparkles },
  { to: "/accounting/rules",              label: "AI Rules",           icon: Wand2 },
  { to: "/accounting/book-review",        label: "Book Review",        icon: ClipboardCheck, feature: "bookkeeper_review" },

  { header: true, label: "Planning & Close" },
  { to: "/accounting/projections",        label: "Projections",        icon: TrendingUp, feature: "outlook" },
  { to: "/accounting/month-close",        label: "Month Close",        icon: CalendarCheck, feature: "month_close" },
  { to: "/accounting/close-books",        label: "Close the Books",    icon: Lock },
  { to: "/compliance",                    label: "Compliance",         icon: ShieldCheck },

  { header: true, label: "Business & Data" },
  { to: "/contacts",                      label: "Contacts",           icon: Users },
  { subGroup: true, key: "connect",       label: "Connect & Import",   icon: Landmark, items: CONNECT_LINKS },
  { to: "/audit-log",                     label: "Audit log",          icon: History },
  { to: "/communications-audit",          label: "Email log",          icon: Inbox },
  { to: "/accounting/settings",           label: "Accounting settings",icon: Settings2 },
];

export default function Todo2CardList({ onExit, collapsed = false, returnPath = "/accounting/todo", variant = "both" }) {
  const { currentId, current } = useCompany();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const showQuickLinks = variant === "both";
  const isFirmUser = canUseCockpit(user);
  const isSuperadmin = (user?.role || "").toLowerCase() === "superadmin";
  const isFirmBooks = current?.is_firm_books === true;
  // Section-2 header label:
  //   • Firm user on firm's own books  → "Firm Books"
  //   • Firm user on a client company  → "Client Area"
  //   • Client-role user (their books) → "Your Books"
  const clientAreaHeader = isFirmUser
    ? (isFirmBooks ? "Firm Books" : "Client Area")
    : "Your Books";
  // Section-1 flavor: superadmins get a "Superadmin" header + platform
  // admin links; every other firm user gets the standard "Professional"
  // header with Today / Clients / Client Cockpit.
  const proSectionHeader = isSuperadmin ? "Superadmin" : "Professional";
  const proSectionLinks = isSuperadmin
    ? [
        { to: "/admin",                  label: "Superadmin",            icon: Shield },
        { to: "/pro/clients",            label: "Clients",               icon: Briefcase },
        { to: "/admin/usage",            label: "Usage & Costs",         icon: Activity },
        { to: "/admin/client-payments",  label: "Client Payments",       icon: Wallet },
        { to: "/admin/product-launches", label: "Product Launch",        icon: Rocket },
        { to: "/cockpit/payments-apps",  label: "Payments Applications", icon: CreditCard },
        { to: "/admin/entitlements",     label: "Plan Gating",           icon: LockIcon },
      ]
    : [
        { to: "/cockpit",        label: "Today",          icon: Sunrise },
        { to: "/pro/clients",    label: "Clients",        icon: Users   },
        { to: "/cockpit/client", label: "Client Cockpit", icon: Activity },
        { to: "/pro/client-payments", label: "Client Payments", icon: Wallet },
      ];
  // Collapse state per section — persisted to localStorage so it sticks
  // across reloads. Default: all sections open.
  const [collapsedPro, setCollapsedPro] = useState(() => {
    try { return localStorage.getItem("sidebar-both-collapsed-pro") === "1"; } catch { return false; }
  });
  const [collapsedClient, setCollapsedClient] = useState(() => {
    try { return localStorage.getItem("sidebar-both-collapsed-client") === "1"; } catch { return false; }
  });
  const [collapsedTodo, setCollapsedTodo] = useState(() => {
    try { return localStorage.getItem("sidebar-both-collapsed-todo") === "1"; } catch { return false; }
  });
  const toggleCollapse = (key, current, setter) => {
    const next = !current;
    setter(next);
    try { localStorage.setItem(`sidebar-both-collapsed-${key}`, next ? "1" : "0"); } catch { /* ignore */ }
  };
  const [items, setItems]   = useState([]);
  const [cashFlow, setCashFlow] = useState(null);
  const [loading, setLoad]  = useState(true);
  const [error, setError]   = useState(null);

  // Mirror the ResponsibilitiesPanel's per-company Review-mode pref
  // so the "Reviewing Transactions" card routes to the surface the
  // user has actually chosen (Review Chat vs. Checklist / Standard).
  // Same storage key used by the panel — no drift.
  const reviewModeKey = `reviewMode.${currentId || "_"}`;
  const [reviewMode] = useUserPref(reviewModeKey, "chat", { localFallback: reviewModeKey });

  // Dashboard "AI Transaction Review" mode (localStorage, same key the
  // dashboard dropdown writes). In that mode the Transactions card shows
  // the time-to-finish estimate and opens the To-do tab directly.
  const readDashMode = () => { try { return localStorage.getItem("dashboard-todos-mode") || "ai"; } catch { return "ai"; } };
  const [dashMode, setDashMode] = useState(readDashMode);
  const aiReview = dashMode === "ai";
  const [unapproved, setUnapproved] = useState(null);
  useEffect(() => {
    const sync = () => setDashMode(readDashMode());
    const onStorage = (e) => { if (e.key === "dashboard-todos-mode") sync(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    const onAction = (e) => { if (e.detail?.kind === "dashboard-mode-changed") sync(); };
    window.addEventListener("axiom:action", onAction);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("focus", sync); window.removeEventListener("axiom:action", onAction); };
  }, []);
  useEffect(() => {
    if (!currentId || !aiReview) return;
    let cancelled = false;
    const fetchCount = () => api.get(`/companies/${currentId}/transactions`, { params: { status: "unapproved", limit: 1 } })
      .then(r => { if (!cancelled) setUnapproved(r.data?.pagination?.total ?? 0); })
      .catch(() => {});
    fetchCount();
    const onChanged = (e) => { if (e.detail?.kind === "txns:changed" || e.detail?.kind === "bulk-approve-done") fetchCount(); };
    window.addEventListener("axiom:action", onChanged);
    return () => { cancelled = true; window.removeEventListener("axiom:action", onChanged); };
  }, [currentId, aiReview]);

  // Silent refresh (no spinner) when an embedded Quick Check-in item is
  // answered/deferred so the card counts drop immediately.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const onAction = (e) => { if (e.detail?.kind === "checkin:changed") setRefreshTick(t => t + 1); };
    window.addEventListener("axiom:action", onAction);
    return () => window.removeEventListener("axiom:action", onAction);
  }, []);

  useEffect(() => {
    if (!currentId) { setLoad(false); return; }
    let cancelled = false;
    const silent = refreshTick > 0;
    (async () => {
      if (!silent) setLoad(true);
      try {
        const [statusR, cashR] = await Promise.allSettled([
          api.get(`/companies/${currentId}/responsibilities/status`,
            { params: { scope: "both" } }),
          api.get(`/companies/${currentId}/cockpit-cards/cashflow-snapshot`),
        ]);
        if (cancelled) return;
        if (statusR.status === "fulfilled") {
          setItems(statusR.value.data?.items || []);
        } else if (!silent) {
          setError(statusR.reason?.response?.data?.detail || "Couldn't load To Do");
        }
        if (cashR.status === "fulfilled") {
          setCashFlow(cashR.value.data || null);
        } else if (!silent) {
          setCashFlow(null);
        }
      } finally {
        if (!cancelled && !silent) setLoad(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, refreshTick]);

  // Filter to only actionable, open items.
  // - Drop "done" and "n/a" (as intended by the panel).
  // - Drop items with no count AND no manual completion flag (nothing
  //   for the CPA to actually do — e.g. a tracked item that's inert).
  // - Prepend a synthetic Cash Flow card when the runway is not
  //   healthy (warning or critical) — it's not a backend catalog item.
  const openItems = useMemo(() => {
    const list = items.filter(it => {
      if (it.status === "done" || it.status === "n/a") return false;
      // Grey Clean Up cards live on the Cockpit only — keep the To Do strip forward-looking.
      if (it.variant === "cleanup" || String(it.key || "").startsWith("cleanup_")) return false;
      // For tracked items with a numeric count, require count > 0.
      if (it.tracked && typeof it.count === "number" && it.count === 0
          && !it.manual_complete && it.status !== "in_progress") {
        return false;
      }
      return true;
    });
    // Synthetic Cash Flow card — only surface it when the projection
    // engine says the account WILL hit $0 within the next 30 days
    // (i.e. `runway_days < 30`). Healthy or merely-warning runway
    // means no card at all; the CPA already has other places to see
    // the number and we don't want noise here.
    if (cashFlow && cashFlow.issue_30d) {
      const runway = typeof cashFlow.runway_days === "number" ? Math.max(0, Math.floor(cashFlow.runway_days)) : null;
      const burnDay = Math.round((cashFlow.forward_monthly_burn || 0) / 30);
      const detail = runway != null && runway < 30
        ? `Only ~${runway}d of runway — burn $${burnDay.toLocaleString()}/d`
        : `Cash dips to $${Math.round(cashFlow.low_30d || 0).toLocaleString()} within 30 days`;
      list.unshift({
        key:       "monitoring_cash_flow",
        label:     "Monitoring Cash Flow",
        status:    "in_progress",
        detail,
        count:     runway ?? 30,
        area_link: cashFlow.open_link || "/accounting/projections",
        tracked:   true,
        danger:    true,   // renderer switches to a red palette
      });
    }
    // Explicit CPA-mental-model order (see CARD_ORDER above). Items
    // not in the map sink to the bottom so any new catalog entry is
    // still discoverable.
    const orderIdx = (key) => {
      const idx = CARD_ORDER.indexOf(key);
      return idx === -1 ? 999 : idx;
    };
    return list.sort((a, b) => {
      const oa = orderIdx(a.key), ob = orderIdx(b.key);
      if (oa !== ob) return oa - ob;
      // Same bucket — bigger backlog first.
      return (b.count ?? 0) - (a.count ?? 0);
    });
  }, [items, cashFlow]);

  const clickCard = (item) => {
    // Reviewing Transactions has two surfaces controlled by a per-user,
    // per-company pref: "chat" → the Review Chat page; "checklist" →
    // the AI Cleanup Review page (the item's default area_link).
    // In chat mode we also deep-link to whichever bucket has the most
    // items so the CPA lands where the work is heaviest.
    if (item.key === "reviewing_transactions") {
      if (aiReview) {
        navigate(_buildOpenHref("/accounting/transactions", "/accounting/todo", "To Do", { filter: "unapproved" }));
      } else if (reviewMode === "chat") {
        const cc = item.chat_counts || {};
        // Pick the biggest non-zero bucket; fall back to no_category.
        const entries = [
          ["no_category",  cc.no_category  || 0],
          ["transactions", cc.transactions || 0],
          ["checks",       cc.checks       || 0],
        ];
        entries.sort((a, b) => b[1] - a[1]);
        const tab = entries[0][1] > 0 ? entries[0][0] : "no_category";
        navigate(_buildOpenHref("/accounting/review-chat",
          "/accounting/todo", "To Do", { tab }));
      } else {
        navigate(_buildOpenHref(item.area_link || "/accounting/ai-cleanup-review",
          "/accounting/todo", "To Do"));
      }
      return;
    }
    if (EMBEDDED_CHECKIN_ROUTES[item.key]) {
      navigate(EMBEDDED_CHECKIN_ROUTES[item.key]);
      return;
    }
    // Prefer the item's own area link, appending any per-card filter
    // params so the destination page opens scoped to the work the
    // sidebar card represents (e.g. Bills → outstanding only).
    const filters = { ...(CARD_FILTERS[item.key] || {}) };
    // Close card → land on the PREVIOUS calendar month (the one you
    // actually close), not the current in-progress month.
    if (item.key === "eom_closing") {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      filters.ym = `${y}-${m}`;
    }
    const target = item.area_link
      ? _buildOpenHref(item.area_link, "/accounting/todo", "To Do", filters)
      : `/accounting/todo#${item.key}`;
    navigate(target);
  };

  const companyLabel = current?.name || "This client";

  // Compute the base pathname a card would navigate to — used to
  // highlight the card matching the current URL as "selected". Pure
  // pathname, no query, so filter params don't break the match.
  const targetPathFor = (item) => {
    if (item.key === "reviewing_transactions") {
      if (aiReview) return "/accounting/transactions";
      return reviewMode === "chat"
        ? "/accounting/review-chat"
        : (item.area_link || "/accounting/ai-cleanup-review").split("?")[0];
    }
    if (EMBEDDED_CHECKIN_ROUTES[item.key]) return EMBEDDED_CHECKIN_ROUTES[item.key].split("?")[0];
    if (!item.area_link) return "/accounting/todo";
    return item.area_link.split("?")[0];
  };
  const isSelected = (item) => {
    const p = targetPathFor(item);
    return location.pathname === p;
  };

  return (
    <div className="flex flex-col h-full" data-testid="sidebar-todo2">
      {/* Back-to-menu + Menu/Page toggle removed — the sidebar-level
          3-way toggle (SidebarModeToggle) now owns all layout
          switching. In the collapsed rail we keep a lone back-arrow
          so users can exit card mode when there's no room for the
          full toggle. */}
      {collapsed && (
        <button
          type="button"
          onClick={onExit}
          title="Back to menu"
          className="mx-auto mb-2 inline-flex items-center justify-center w-8 h-8 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition"
          data-testid="sidebar-todo2-back"
        >
          <ArrowLeft size={14} />
        </button>
      )}

      {!collapsed && showQuickLinks && (
        <>
          {/* Quick-links — same look as the normal sidebar Item rows.
              Clicking one navigates but stays in card mode so the
              user can keep triaging tasks while jumping around.
              Hidden when the sidebar is in the "todo" (cards-only)
              variant — that mode intentionally shows nothing but
              the top-level toggle and the task cards. */}
          <div className="mb-2" data-testid="sidebar-todo2-quick-links">
            {/* Professional / Superadmin section — firm-only cross-client
                shortcuts rendered ABOVE the Client Area. Header label
                and link list flip to a Superadmin flavor when the user
                has role=superadmin. */}
            {isFirmUser && (
              <>
                <button
                  type="button"
                  onClick={() => toggleCollapse("pro", collapsedPro, setCollapsedPro)}
                  className="w-full flex items-center justify-between px-3 pt-3 pb-1 mb-1 border-b border-slate-200 text-[10px] uppercase tracking-widest text-slate-400 font-semibold hover:text-slate-600 transition-colors"
                  data-testid="sidebar-todo2-professional-header"
                  aria-expanded={!collapsedPro}
                >
                  <span>{proSectionHeader}</span>
                  {collapsedPro
                    ? <ChevronRight size={12} className="text-slate-400" />
                    : <ChevronDown size={12} className="text-slate-400" />}
                </button>
                {!collapsedPro && proSectionLinks.map((l) => {
                  const active = location.pathname === l.to;
                  const Icon = l.icon;
                  return (
                    <button
                      key={l.to}
                      type="button"
                      onClick={() => navigate(l.to)}
                      className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                        active ? "bg-slate-100 text-slate-900 font-medium" : "text-slate-700 hover:bg-slate-100"
                      }`}
                      data-testid={`sidebar-todo2-pro-link-${l.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Icon size={16} className="text-slate-500" strokeWidth={2} />
                      <span className="truncate">{l.label}</span>
                    </button>
                  );
                })}
              </>
            )}
            {/* Section header above the accounting quick-links.
                Reads "Firm Books" / "Client Area" for firm users based
                on which company they're viewing, and "Your Books" for
                the client-role owner viewing their own company. Always
                shown so every user gets a visual anchor. */}
            {showQuickLinks && (
              <button
                type="button"
                onClick={() => toggleCollapse("client", collapsedClient, setCollapsedClient)}
                className="w-full flex items-center justify-between px-3 pt-3 pb-1 mb-1 border-b border-slate-200 text-[10px] uppercase tracking-widest text-slate-400 font-semibold hover:text-slate-600 transition-colors"
                data-testid="sidebar-todo2-context-header"
                aria-expanded={!collapsedClient}
              >
                <span>{clientAreaHeader}</span>
                {collapsedClient
                  ? <ChevronRight size={12} className="text-slate-400" />
                  : <ChevronDown size={12} className="text-slate-400" />}
              </button>
            )}
            {!collapsedClient && (
              <>
                {QUICK_LINKS.map((l) => {
                  const active = location.pathname === l.to;
                  const Icon = l.icon;
                  return (
                    <button
                      key={l.to}
                      type="button"
                      onClick={() => navigate(l.to)}
                      className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                        active ? "bg-slate-100 text-slate-900 font-medium" : "text-slate-700 hover:bg-slate-100"
                      }`}
                      data-testid={`sidebar-todo2-quick-link-${l.label.toLowerCase()}`}
                    >
                      <Icon size={16} className="text-slate-500" strokeWidth={2} />
                      <span className="truncate">{l.label}</span>
                    </button>
                  );
                })}
                <AccountingAccordion navigate={navigate} activePath={location.pathname} />
                <MoreAccordion navigate={navigate} activePath={location.pathname} />
              </>
            )}
          </div>
        </>
      )}

      <div className={`pb-3 ${collapsed ? "px-0 space-y-1" : "px-1.5 space-y-1.5"}`}>
        {/* To Do section header — sits between the All accordion and
            the actionable task cards. Hidden in rail (collapsed) mode
            where there's no room for a text label. Clickable to
            collapse the task-cards list below. */}
        {!collapsed && showQuickLinks && (
          <button
            type="button"
            onClick={() => toggleCollapse("todo", collapsedTodo, setCollapsedTodo)}
            className="w-full flex items-center justify-between px-3 pt-1 pb-1 mb-1 border-b border-slate-200 text-[10px] uppercase tracking-widest text-slate-400 font-semibold hover:text-slate-600 transition-colors"
            data-testid="sidebar-todo2-todo-header"
            aria-expanded={!collapsedTodo}
          >
            <span>To Do</span>
            {collapsedTodo
              ? <ChevronRight size={12} className="text-slate-400" />
              : <ChevronDown size={12} className="text-slate-400" />}
          </button>
        )}
        {!collapsedTodo && loading && (
          <div className="flex items-center justify-center py-6 text-slate-400" data-testid="sidebar-todo2-loading">
            <Loader2 size={14} className="animate-spin" />
          </div>
        )}
        {!collapsedTodo && error && !loading && !collapsed && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-[11px] text-red-700 flex items-start gap-1.5" data-testid="sidebar-todo2-error">
            <CircleAlert size={12} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {!collapsedTodo && error && !loading && collapsed && (
          <div className="flex justify-center py-2 text-red-600" title={error} data-testid="sidebar-todo2-error">
            <CircleAlert size={16} />
          </div>
        )}
        {!collapsedTodo && !loading && !error && openItems.length === 0 && !collapsed && (
          <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50/40 px-3 py-4 text-center text-[12px] text-emerald-700"
               data-testid="sidebar-todo2-empty">
            🎉 You're clear.<br/>Enjoy the quiet.
          </div>
        )}
        {!collapsedTodo && !loading && !error && openItems.map((it) => {
          const meta = TIER[it.key] || { tier: "pro", label: "Professional" };
          const style = TIER_STYLES[meta.tier];
          const Icon = style.Icon;
          const cardLabel = CARD_LABELS[it.key] || it.label;
          // For Reviewing Transactions in chat mode we show the 3-bucket
          // breakdown that the Review Chat page uses (No Category ·
          // Transactions · Checks) instead of the raw needs-review
          // total, so the sidebar reads like the destination.
          const chatCounts = it.chat_counts;
          const isTxnAi = it.key === "reviewing_transactions" && aiReview;
          const isTxnChat = it.key === "reviewing_transactions"
            && !aiReview && reviewMode === "chat" && chatCounts;
          const chatTotal = isTxnChat
            ? (chatCounts.no_category || 0)
              + (chatCounts.transactions || 0)
              + (chatCounts.checks || 0)
            : null;
          const countChip = isTxnAi
            ? (unapproved ? reviewEta(unapproved) : null)
            : isTxnChat
            ? (chatTotal > 0 ? chatTotal : null)
            : (typeof it.count === "number" && it.count > 0 ? it.count : null);

          const selected = isSelected(it);

          // Danger cards (currently only the synthetic Cash Flow row
          // when runway < 30d) wear a red palette regardless of
          // selection so they cut through the visual noise.
          const danger = !!it.danger;

          // Collapsed rail: icon-only tile. Uses the same gray base +
          // blue-glow-when-selected treatment as the expanded card so
          // both modes read consistently. Danger overrides both to red.
          if (collapsed) {
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => clickCard(it)}
                title={cardLabel}
                aria-label={cardLabel}
                aria-current={selected ? "page" : undefined}
                className={`group mx-auto flex items-center justify-center w-10 h-10 rounded-md border transition-all ${
                  danger
                    ? "bg-red-50 border-red-400 ring-2 ring-red-400/60 shadow-md shadow-red-400/30"
                    : selected
                    ? "bg-blue-50 border-blue-400 ring-2 ring-blue-400/60 shadow-md shadow-blue-400/30"
                    : "bg-slate-100 border-slate-200 hover:bg-slate-50 hover:-translate-y-[1px]"
                }`}
                data-testid={`sidebar-todo2-card-${it.key}`}
              >
                <Icon size={16} className={danger ? "text-red-700" : selected ? "text-blue-700" : "text-slate-500"} />
              </button>
            );
          }

          return (
            <button
              key={it.key}
              type="button"
              onClick={() => clickCard(it)}
              aria-current={selected ? "page" : undefined}
              className={`group w-full text-left rounded-md border transition-all ${
                danger
                  ? "bg-red-50 border-red-400 ring-2 ring-red-400/60 shadow-md shadow-red-400/30"
                  : selected
                  ? "bg-blue-50 border-blue-400 ring-2 ring-blue-400/60 shadow-md shadow-blue-400/30"
                  : "bg-slate-100 border-slate-200 hover:bg-slate-50 hover:-translate-y-[1px]"
              }`}
              data-testid={`sidebar-todo2-card-${it.key}`}
            >
              <div className="p-2">
                <div className="flex items-start gap-1.5 mb-1">
                  <div className={`text-[12px] font-semibold leading-tight flex-1 min-w-0 ${
                    danger ? "text-red-800" : selected ? "text-blue-800" : "text-blue-700"
                  }`}>
                    {cardLabel}
                  </div>
                  {countChip !== null && (
                    <span className={`shrink-0 text-[10px] font-mono-num font-semibold border rounded px-1.5 ${
                      danger
                        ? "text-red-800 bg-white border-red-200"
                        : selected
                        ? "text-blue-800 bg-white border-blue-200"
                        : "text-slate-700 bg-white border-slate-200"
                    }`}>
                      {countChip}
                    </span>
                  )}
                </div>
                {isTxnAi ? (
                  <div className="text-[11px] text-slate-600 mt-0.5" data-testid="sidebar-todo2-txn-eta">
                    {unapproved == null ? "…" : unapproved === 0 ? "All reviewed" : (() => {
                      const m = reviewMinutes(unapproved);
                      const span = m >= 60 ? `${Math.floor(m / 60)} Hour${Math.floor(m / 60) === 1 ? "" : "s"}${m % 60 ? ` ${m % 60} Minutes` : ""}` : `${m} Minute${m === 1 ? "" : "s"}`;
                      return `Estimated ${span} to complete.`;
                    })()}
                  </div>
                ) : isTxnChat ? (
                  <div className="text-[11px] text-slate-600 mt-0.5">
                    {chatTotal} {chatTotal === 1 ? "Question" : "Questions"}
                  </div>
                ) : it.detail && (
                  <div className={`text-[11px] mt-0.5 line-clamp-2 ${danger ? "text-red-700" : "text-slate-600"}`}>
                    {it.detail}
                  </div>
                )}
                <div className={`flex items-center justify-end mt-1 transition-colors ${
                  danger ? "text-red-600" : selected ? "text-blue-600" : "text-slate-400 group-hover:text-blue-600"
                }`}>
                  <ChevronRight size={12} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Collapsible "All" accordion rendered under the Reports quick-link.
// Persists its open/closed state in localStorage so the CPA doesn't have to
// re-expand it every time they navigate. Uses the same row styling as the
// quick-links above for visual continuity.
//
// Renamed from "Accounting" → "All" (Sep 2026) to match the Full-mode
// sidebar and also supports one-level-deep nested subgroups
// (Sales & Payments, Purchases) via `subGroup: true` entries in
// ACCOUNTING_LINKS.
function MoreAccordion({ navigate, activePath }) {
  const anyChildActive = MORE_LINKS.some((l) => activePath.startsWith(l.to));
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("sb_more_open") === "1"; }
    catch (_) { return false; }
  });
  useEffect(() => { if (anyChildActive) setOpen(true); }, [anyChildActive]);
  const toggle = () => setOpen((v) => {
    const nv = !v;
    try { localStorage.setItem("sb_more_open", nv ? "1" : "0"); } catch (_) { /* best-effort */ }
    return nv;
  });
  return (
    <div className="mt-0.5" data-testid="sidebar-todo2-more-accordion">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
          anyChildActive && !open
            ? "bg-slate-100 text-slate-900 font-medium"
            : "text-slate-700 hover:bg-slate-100"
        }`}
        data-testid="sidebar-todo2-more-toggle"
      >
        <MoreHorizontal size={16} className="text-slate-500" strokeWidth={2} />
        <span className="truncate flex-1">More</span>
        <ChevronDown
          size={14}
          className={`text-slate-400 transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="pl-4 mt-0.5" data-testid="sidebar-todo2-more-panel">
          {MORE_LINKS.map((l) => {
            const active = activePath.startsWith(l.to);
            const Icon = l.icon;
            return (
              <button
                key={l.to}
                type="button"
                onClick={() => navigate(l.to)}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-left transition-colors ${
                  active ? "bg-slate-100 text-slate-900 font-medium" : "text-slate-700 hover:bg-slate-100"
                }`}
                data-testid={`sidebar-todo2-more-${l.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              >
                <Icon size={14} className="text-slate-500" strokeWidth={2} />
                <span className="truncate">{l.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AccountingAccordion({ navigate, activePath }) {
  const { can: canFeature, openUpgrade } = useEntitlements();
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("axiom_todo2_accounting_open") === "1"; }
    catch (_) { return false; }
  });
  // Per-subgroup open state, persisted independently. Keeps the two
  // nested "Sales & Payments" / "Purchases" accordions from resetting
  // every time the outer "All" toggle is flipped.
  const [subOpen, setSubOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("axiom_todo2_accounting_subopen") || "{}"); }
    catch (_) { return {}; }
  });
  const toggle = () => setOpen((v) => {
    const nv = !v;
    try { localStorage.setItem("axiom_todo2_accounting_open", nv ? "1" : "0"); }
    catch (_) { /* private mode — best-effort */ }
    return nv;
  });
  const toggleSub = (key) => setSubOpen((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem("axiom_todo2_accounting_subopen", JSON.stringify(next)); }
    catch (_) { /* best-effort */ }
    return next;
  });
  const anyChildActive = ACCOUNTING_LINKS.some((l) =>
    l.header
      ? false
      : l.subGroup
        ? (l.items || []).some((s) => activePath === s.to.split("?")[0])
        : activePath === l.to
  );
  return (
    <div className="mt-0.5" data-testid="sidebar-todo2-accounting-accordion">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
          anyChildActive && !open
            ? "bg-slate-100 text-slate-900 font-medium"
            : "text-slate-700 hover:bg-slate-100"
        }`}
        data-testid="sidebar-todo2-accounting-toggle"
      >
        <ListTree size={16} className="text-slate-500" strokeWidth={2} />
        <span className="truncate flex-1">All</span>
        <ChevronDown
          size={14}
          className={`text-slate-400 transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="pl-4 mt-0.5" data-testid="sidebar-todo2-accounting-panel">
          {ACCOUNTING_LINKS.map((l, idx) => {
            // Section header — non-clickable divider. Uppercase +
            // small so it visually separates workflow clusters
            // without competing with the leaf-link rows. First
            // header has less top-margin so it hugs the accordion.
            if (l.header) {
              return (
                <div
                  key={`hdr-${l.label}-${idx}`}
                  className={`text-[10px] uppercase tracking-widest font-semibold text-slate-400 px-3 pb-1 border-b border-slate-200 mb-1 ${
                    idx === 0 ? "pt-1" : "pt-3"
                  }`}
                  data-testid={`sidebar-todo2-accounting-header-${l.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                >
                  {l.label}
                </div>
              );
            }
            // Nested subgroup — inline collapsible one indent-level
            // deeper than a leaf link. Same visual pattern as the
            // Full-mode sidebar's subGroup rendering.
            if (l.subGroup) {
              const isOpen = !!subOpen[l.key];
              const SubIcon = l.icon;
              return (
                <div key={l.key} data-testid={`sidebar-todo2-accounting-subgroup-${l.key}`}>
                  <button
                    type="button"
                    onClick={() => toggleSub(l.key)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-100 text-left"
                    data-testid={`sidebar-todo2-accounting-subgroup-toggle-${l.key}`}
                  >
                    <SubIcon size={14} className="text-slate-500" strokeWidth={2} />
                    <span className="truncate flex-1">{l.label}</span>
                    <ChevronDown
                      size={12}
                      className={`text-slate-400 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="pl-4 mt-0.5">
                      {(l.items || []).map((sub) => {
                        const active = activePath === sub.to.split("?")[0];
                        const SIcon = sub.icon;
                        return (
                          <button
                            key={sub.to}
                            type="button"
                            onClick={() => navigate(sub.to)}
                            className={`w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-left transition-colors ${
                              active
                                ? "bg-slate-100 text-slate-900 font-medium"
                                : "text-slate-700 hover:bg-slate-100"
                            }`}
                            data-testid={`sidebar-todo2-accounting-${l.key}-${sub.label.toLowerCase().replace(/\s+/g, "-")}`}
                          >
                            <SIcon size={14} className="text-slate-500" strokeWidth={2} />
                            <span className="truncate">{sub.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            const active = activePath === l.to;
            const Icon = l.icon;
            const locked = !!l.feature && !canFeature(l.feature);
            return (
              <button
                key={l.to}
                type="button"
                onClick={() => (locked ? openUpgrade(l.feature) : navigate(l.to))}
                data-locked={locked || undefined}
                title={locked ? "Included in a higher plan — tap to see options" : undefined}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-left transition-colors ${
                  active
                    ? "bg-slate-100 text-slate-900 font-medium"
                    : "text-slate-700 hover:bg-slate-100"
                } ${locked ? "opacity-60" : ""}`}
                data-testid={`sidebar-todo2-accounting-${l.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <Icon size={14} className="text-slate-500" strokeWidth={2} />
                <span className="truncate flex-1">{l.label}</span>
                {locked && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-900 text-white" data-testid={`nav-lock-${l.feature}`}>
                    <LockIcon size={9} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

