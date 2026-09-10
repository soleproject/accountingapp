import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard, FileText, Receipt, CreditCard, ScrollText, BarChart3,
  Users, Link2, Inbox, ChevronDown, ChevronRight, ArrowLeftRight, Boxes,
  Building2, Wallet, Tags, CheckCheck, ClipboardCheck, CalendarCheck, Calendar,
  BookOpen, Notebook, ListTree, Sparkles, Shield, Briefcase, Wand2,
  PanelLeftClose, PanelLeft, Settings2, Share2, Activity, Repeat, Package,
  MailCheck, UserCircle, Store, Landmark, Download, ShoppingCart, Coins,
  Percent, Lock, History, FlaskConical, Layers, Target, Clock, GitBranch,
  Home, ArrowLeft, Calculator, Mail, Rocket, Printer, MoreHorizontal, Search,
  Aperture, CheckSquare,
} from "lucide-react";

import { useNavStyle } from "@/lib/navStyle";

/**
 * ModulesSwitcher — the "← Modules" escape hatch that appears in
 * menu mode on every product-scoped sidebar. Clicking it toggles an
 * inline reveal of the Home + Modules list so users can jump to
 * another product without navigating away from their current page.
 */
function ModulesSwitcher({ user }) {
  const [open, setOpen] = useState(false);
  const visibleModules = _visibleModules(user);
  const withoutHome = visibleModules.filter(m => m.key !== "home");
  return (
    <div className="mx-3 mb-2 mt-0.5"
          data-testid="sidebar-modules-switcher">
      <button type="button"
              onClick={() => setOpen(v => !v)}
              data-testid="sidebar-modules-switcher-toggle"
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-slate-400 hover:text-slate-700 transition">
        {open
          ? <ChevronDown size={10} />
          : <ArrowLeft size={10} />}
        Modules
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-slate-200 bg-white shadow-sm p-1 space-y-0.5"
              data-testid="sidebar-modules-switcher-panel">
          {user?.show_home && (
            <SwitcherLink to="/home" icon={Home} label="Home" />
          )}
          {withoutHome.length > 0 && (
            <div className="text-[9px] uppercase tracking-widest text-slate-400 font-semibold px-2 pt-1">
              Modules
            </div>
          )}
          {withoutHome.map(m => (
            <SwitcherLink key={m.key} to={m.to} icon={m.icon} label={m.label} />
          ))}
        </div>
      )}
    </div>
  );
}

function SwitcherLink({ to, icon: Icon, label }) {
  return (
    <NavLink to={to}
              data-testid={`sidebar-modules-switcher-${label.toLowerCase()}`}
              className={({ isActive }) => `flex items-center gap-2 px-2 py-1 rounded text-xs ${
                isActive
                  ? "bg-cyan-50 text-cyan-800 font-medium"
                  : "text-slate-700 hover:bg-slate-50"
              }`}>
      <Icon size={12} /> {label}
    </NavLink>
  );
}

/**
 * ModulesDropdown — third nav style. Renders a proper dropdown pill
 * at the top of the sidebar showing the current module; opening it
 * lets the user jump to any other module. Selecting one navigates
 * to that module's home which re-paints the whole sidebar with that
 * module's menu items.
 */
const _MODULES = [
  { key: "home",       to: "/home",                    label: "Home",       icon: Home,       hex: "#6366F1" },
  { key: "crm",        to: "/crm",                     label: "CRM",        icon: Users,      hex: "#7C3AED" },
  { key: "projects",   to: "/accounting/projects",     label: "Projects",   icon: Briefcase,  hex: "#D97706" },
  { key: "team",       to: "/team",                    label: "Team",       icon: Building2,  hex: "#059669" },
  { key: "accounting", to: "/dashboard",               label: "Accounting", icon: Calculator, hex: "#0891B2" },
];

// Product-launch gate — filter modules based on the backend's
// `enabled_products` + `show_home` from /auth/me. Superadmins always
// have every product server-side, so this filter naturally passes
// everything for them (Round 7.21, Feb 2026).
function _visibleModules(user) {
  const enabled = new Set(user?.enabled_products || ["accounting"]);
  const showHome = !!user?.show_home;
  return _MODULES.filter(m => {
    if (m.key === "home") return showHome;
    return enabled.has(m.key);
  });
}

function ModulesDropdown({ activeKey, collapsed = false, user }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const visibleModules = _visibleModules(user);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const current = _MODULES.find(m => m.key === activeKey) || visibleModules[0] || _MODULES[0];
  const CurrentIcon = current.icon;

  // Collapsed variant: just the icon, centered, panel floats to the right.
  if (collapsed) {
    return (
      <div ref={rootRef}
            className="relative mb-2 mt-0.5"
            data-testid="sidebar-modules-dropdown">
        <button type="button"
                onClick={() => setOpen(v => !v)}
                data-testid="sidebar-modules-dropdown-toggle"
                aria-expanded={open}
                title={`Module · ${current.label}`}
                className="w-full flex items-center justify-center py-2 rounded-md border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition">
          <CurrentIcon size={16} style={{ color: current.hex }} strokeWidth={2} />
        </button>
        {open && (
          <div data-testid="sidebar-modules-dropdown-panel"
                className="absolute left-full top-0 ml-2 z-40 w-52 rounded-md border border-slate-200 bg-white shadow-lg py-1">
            {visibleModules.map(m => {
              const Icon = m.icon;
              const isActive = m.key === activeKey;
              return (
                <NavLink key={m.key}
                          to={m.to}
                          onClick={() => setOpen(false)}
                          data-testid={`sidebar-modules-dropdown-${m.key}`}
                          className={`flex items-center gap-3 px-3 py-2 text-sm transition ${
                            isActive
                              ? "bg-slate-50 font-medium text-slate-900"
                              : "text-slate-700 hover:bg-slate-50"
                          }`}>
                  <Icon size={16} style={{ color: m.hex }} strokeWidth={2} />
                  <span className="flex-1 truncate">{m.label}</span>
                  {isActive && (
                    <span className="text-[9px] uppercase tracking-widest text-slate-400 font-semibold">
                      Current
                    </span>
                  )}
                </NavLink>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef}
          className="relative mb-2 mt-0.5"
          data-testid="sidebar-modules-dropdown">
      {/* Pill uses the same px-3 py-2 rhythm as regular nav items so
          the icon + label line up perfectly with Dashboard, All Projects,
          etc. below it. No horizontal margin. */}
      <button type="button"
              onClick={() => setOpen(v => !v)}
              data-testid="sidebar-modules-dropdown-toggle"
              aria-expanded={open}
              className="w-full flex items-center gap-3 rounded-md px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition text-left">
        <CurrentIcon size={16} style={{ color: current.hex }} strokeWidth={2} />
        <span className="flex-1 min-w-0 text-base font-semibold text-slate-900 truncate leading-tight">
          {current.label}
        </span>
        <ChevronDown size={14}
                      className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}/>
      </button>
      {open && (
        <div data-testid="sidebar-modules-dropdown-panel"
              className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md border border-slate-200 bg-white shadow-lg py-1">
          {visibleModules.map(m => {
            const Icon = m.icon;
            const isActive = m.key === activeKey;
            return (
              <NavLink key={m.key}
                        to={m.to}
                        onClick={() => setOpen(false)}
                        data-testid={`sidebar-modules-dropdown-${m.key}`}
                        className={`flex items-center gap-3 px-3 py-2 text-sm transition ${
                          isActive
                            ? "bg-slate-50 font-medium text-slate-900"
                            : "text-slate-700 hover:bg-slate-50"
                        }`}>
                <Icon size={16} style={{ color: m.hex }} strokeWidth={2} />
                <span className="flex-1 truncate">{m.label}</span>
                {isActive && (
                  <span className="text-[9px] uppercase tracking-widest text-slate-400 font-semibold">
                    Current
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { TID } from "@/constants/testIds";
import { useAuth } from "@/lib/auth";
import { canUseCockpit } from "@/lib/cockpitAccess";
import { useBranding } from "@/lib/branding";
import { useCompany } from "@/lib/company";
import { detectProduct } from "./ProductRail";

const NAV_COLOR = "#64748B";

/**
 * Grouped left-nav. Each group has a header row that toggles a
 * disclosure panel of sub-items. Groups auto-expand when the current
 * route matches one of their children so the user always sees where
 * they are.
 */
const GROUPS = [
  {
    key: "sales",
    label: "Sales & Payments",
    icon: FileText,
    items: [
      { to: "/estimates", label: "Estimates", icon: FileText },
      { to: "/invoices", label: "Invoices", icon: FileText },
      { to: "/sales-receipts", label: "Sales Receipts", icon: Receipt, advancedOnly: true },
      { to: "/refund-receipts", label: "Refund Receipts", icon: Receipt, advancedOnly: true },
      { to: "/credit-memos", label: "Credit Memos", icon: FileText, advancedOnly: true },
      { to: "/payments?direction=in", label: "Payments", icon: CreditCard, matchPath: "/payments" },
      { to: "/items?usage=sales", label: "Products & Services", icon: Package, matchPath: "/items" },
      { to: "/recurring", label: "Recurring", icon: Repeat },
      { to: "/customer-statements", label: "Customer Statements", icon: MailCheck },
      { to: "/contacts?type=customer", label: "Customers", icon: UserCircle, matchPath: "/contacts" },
    ],
  },
  {
    key: "purchases",
    label: "Purchases",
    icon: ShoppingCart,
    items: [
      { to: "/purchase-orders", label: "Purchase Orders", icon: FileText },
      { to: "/bills", label: "Bills", icon: Receipt },
      { to: "/vendor-credits", label: "Vendor Credits", icon: FileText, advancedOnly: true },
      { to: "/payments?direction=out", label: "Payments", icon: CreditCard, matchPath: "/payments" },
      { to: "/payments?type=cc", label: "Credit Card Payments", icon: CreditCard, matchPath: "/payments" },
      { to: "/items?usage=purchases", label: "Items", icon: Package, matchPath: "/items" },
      { to: "/contacts?type=vendor", label: "Vendors", icon: Store, matchPath: "/contacts" },
    ],
  },
  {
    key: "banking",
    label: "Connect & Import",
    icon: Landmark,
    items: [
      { to: "/connections", label: "Connect Accounts", icon: Link2, exact: true },
      { to: "/connections?view=imports", label: "Import Statements", icon: Download, matchPath: "/connections", exact: true },
      { to: "/connections/qbo", label: "Connect QBO", icon: Link2, matchPath: "/connections/qbo" },
      { to: "/test-qbo", label: "Test QBO", icon: FlaskConical, matchPath: "/test-qbo", superadminOnly: true },
    ],
  },
  {
    key: "accounting",
    label: "Accounting",
    icon: ListTree,
    items: [
      { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
      { to: "/accounting/chart-of-accounts", label: "Chart of Accounts", icon: ListTree },
      { to: "/accounting/classes", label: "Classes", icon: Layers, classesEnabledOnly: true },
      { to: "/accounting/budgets", label: "Budgets", icon: Target, budgetsEnabledOnly: true },
      { to: "/accounting/assets", label: "Assets", icon: Building2 },
      { to: "/accounting/loans", label: "Loans", icon: Wallet },
      { to: "/inventory-management", label: "Inventory", icon: Boxes, matchPath: "/inventory-management" },
      { to: "/accounting/tags", label: "Tags", icon: Tags },
      { to: "/accounting/reconciliation", label: "Reconciliation", icon: CheckCheck },
      { to: "/accounting/bank-matches", label: "Bank Match Review", icon: Link2, advancedOnly: true },
      { to: "/accounting/checks", label: "Print Checks", icon: Printer },
      { to: "/accounting/journal-entries", label: "Journal Entries", icon: BookOpen },
      { to: "/accounting/general-ledger", label: "General Ledger", icon: Notebook },
      { to: "/accounting/sales-tax", label: "Sales Tax Center", icon: Percent },
      { to: "/accounting/ai-cleanup-review", label: "AI Cleanup Review", icon: Sparkles },
      { to: "/accounting/rules", label: "AI Rules", icon: Wand2 },
      { to: "/accounting/book-review", label: "Book Review", icon: ClipboardCheck },
      { to: "/accounting/month-close", label: "Month Close", icon: CalendarCheck },
      { to: "/accounting/close-books", label: "Close the Books", icon: Lock },
      // Audit log sits directly under Close the Books so the audit trail
      // lives inside the Accounting group next to the workflows it records.
      { to: "/audit-log", label: "Audit log", icon: History },
    ],
  },
];

/** Accounting shell's top-of-sidebar link — renamed from
 *  "Dashboard" to "Overview" so it doesn't compete semantically
 *  with the platform-wide Home (which now lives on the Product
 *  Rail — see `ProductRail.jsx`).
 */
const ACCOUNTING_TOP = { to: "/dashboard", label: "Overview",
                          icon: LayoutDashboard, exact: true };
// Between purchases and banking:
const AFTER_PURCHASES = [
  { to: "/receipts", label: "Receipts", icon: ScrollText },
];
// Between banking and accounting:
const AFTER_BANKING = [
  { to: "/reports", label: "Reports", icon: BarChart3 },
  // Consolidated Contacts entry — the Customers / Vendors items under
  // Sales & Purchases filter by `?type=`, but auto-imported contacts
  // (Plaid syncs, Veryfi statement uploads) land with `type: null`
  // pending manual tagging, which made them invisible to those filtered
  // views. This "All contacts" landing sits between Reports and
  // Accounting so users can find every contact regardless of type.
  { to: "/contacts", label: "Contacts", icon: Users, matchPath: "/contacts" },
  // Projects — surfaced as its own top-level entry (below Contacts,
  // above Accounting) because the PM workflow is job-centric and
  // shouldn't be buried inside the Accounting group. Gated by
  // `projectsEnabled` so basic-mode users don't see it.
  { to: "/accounting/projects", label: "Projects", icon: Briefcase, matchPath: "/accounting/projects", projectsEnabledOnly: true },
];
// After accounting group:
// NOTE: Audit log used to live here — moved into the Accounting shell
// as an item directly under "Accounting Settings" so the audit trail
// sits next to the settings it audits (Round 7.8, Feb 2026).
const STANDALONE_BOTTOM = [
  { to: "/my-businesses", label: "My Businesses", icon: Briefcase },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/share", label: "Refer & earn", icon: Share2 },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

// -------- Sidebar search index -----------------------------------------
// Flat, searchable list of every user-facing route the sidebar can reach.
// Extra keywords help pros find pages by intent (e.g. "1099" → Contacts,
// "aging" → Reports). Kept next to the GROUPS/STANDALONE arrays so that
// adding a new nav item is a one-line change here and picks up search
// automatically.
const SEARCH_INDEX = (() => {
  const rows = [];
  const push = (label, to, keywords = "", groupLabel = "") => {
    rows.push({ label, to, keywords: keywords.toLowerCase(), groupLabel });
  };
  for (const g of GROUPS) {
    for (const it of g.items) {
      push(it.label, it.to, it.keywords || "", g.label);
    }
  }
  for (const it of STANDALONE_BOTTOM) push(it.label, it.to);

  // Extras that don't live in GROUPS (top-level, admin, product-scoped).
  push("Overview", "/dashboard", "home dashboard");
  push("Reports", "/reports", "reports pl p&l income balance-sheet aging tax");
  push("A/R Aging", "/reports/ar-aging", "receivables collections overdue past due");
  push("A/P Aging · Bills to Pay", "/reports/ap-aging", "payables bills unpaid");
  push("Sales Tax Report", "/reports/sales-tax-report", "taxable nontaxable period");
  push("Sales Tax Liability", "/reports/sales-tax", "sales tax owed liability");
  push("Trial Balance", "/reports/trial-balance", "gl ledger debit credit");
  push("Balance Sheet", "/reports/balance-sheet", "assets liabilities equity");
  push("Income Statement", "/reports/income-statement", "profit loss pnl");
  push("General Ledger", "/reports/general-ledger", "gl transactions detail");
  push("Cash Flow", "/reports/cash-flow", "cashflow");
  push("1099 Summary", "/reports/1099-summary", "1099 contractor w9 nec");
  push("Sales Tax Center", "/accounting/sales-tax", "sales tax rates agency payment");
  push("Transactions", "/transactions", "categorize bank feed banking");
  push("Reconciliation", "/reconciliation", "reconcile bank match");
  push("Journal Entries", "/journal-entries", "je manual entry");
  push("Chart of Accounts", "/accounts", "coa accounts");

  // ---- CRM product sub-items (not in GROUPS — rendered inline) ----
  push("CRM Overview", "/crm", "crm dashboard pipeline overview", "CRM");
  push("Deals", "/crm/deals", "pipeline opportunities kanban stages", "CRM");
  push("Email", "/crm/email", "inbox outreach gmail outlook messages", "CRM");
  push("Calendar", "/crm/calendar", "schedule meetings appointments events crm", "CRM");
  push("Contacts", "/contacts?product=crm", "customers vendors leads people crm", "CRM");
  push("CRM Settings", "/crm/settings", "crm configuration pipelines stages", "CRM");

  // ---- Team product sub-items (not in GROUPS — rendered inline) ----
  push("Employees", "/team", "team staff people hr employees roster", "Team");
  push("Time", "/team/time", "timesheet clock hours tracking timelogs", "Team");
  push("Calendar", "/team/calendar", "schedule pto leave shift team calendar", "Team");
  push("Approvals", "/team/approvals", "expense approve review pending queue", "Team");

  // ---- Projects product sub-items (not in GROUPS — rendered inline) ----
  push("Projects Dashboard", "/accounting/projects", "projects overview jobs", "Projects");
  push("All projects", "/accounting/projects/list", "project list jobs all", "Projects");
  push("Estimates vs Actuals", "/reports/estimates-vs-actuals", "budget variance job costing estimates actuals", "Projects");

  return rows;
})();

// --- helpers ---------------------------------------------------------------

// Precompute: for each pathname served by the sidebar, how many
// distinct items point to it? When >1, the sidebar behaves "sticky" —
// it remembers which specific item the user last clicked so in-page
// toggles (that change the query but not the pathname) don't jump
// the highlight between groups.
const ITEM_PATH_COUNTS = (() => {
  const counts = {};
  for (const g of GROUPS) {
    for (const it of g.items) {
      const p = it.matchPath || it.to.split("?")[0];
      if (p === "__never__") continue;
      counts[p] = (counts[p] || 0) + 1;
    }
  }
  return counts;
})();

const STICKY_KEY = "sb_nav_sticky_item";
const readSticky = () => {
  try { return JSON.parse(localStorage.getItem(STICKY_KEY) || "{}"); }
  catch { return {}; }
};
const writeSticky = (map) => {
  localStorage.setItem(STICKY_KEY, JSON.stringify(map));
};
// Fired when a sidebar item is clicked so the storage listener below
// picks it up in the same tab without waiting for a re-render.
const STICKY_EVENT = "sb-nav-sticky-changed";
const rememberSticky = (group, item) => {
  const p = item.matchPath || item.to.split("?")[0];
  if (!ITEM_PATH_COUNTS[p] || ITEM_PATH_COUNTS[p] < 2) return; // no ambiguity
  const map = readSticky();
  map[p] = { groupKey: group.key, label: item.label };
  writeSticky(map);
  window.dispatchEvent(new Event(STICKY_EVENT));
};

const isItemActive = (loc, item, sticky = {}, groupKey = null) => {
  // Prefer explicit matchPath (used when the link carries query params).
  const p = item.matchPath || item.to.split("?")[0];
  // `exact: true` limits highlighting to an EQUALS pathname match. Used
  // when a sibling item lives on a deeper sub-route (e.g. Connect
  // Accounts lives at `/connections`, Connect QBO at `/connections/qbo`
  // — without `exact`, Connect Accounts would light up on the QBO page).
  const pathHit = item.exact
    ? loc.pathname === p
    : (loc.pathname === p || loc.pathname.startsWith(p + "/"));
  if (!pathHit) return false;

  // Special case for query-param-scoped items (Customers, Vendors, etc.):
  // when the CURRENT URL has zero relevant query params, ONLY the item
  // whose `to` also has zero query params (i.e. the "all" landing view)
  // should light up. This prevents the "click sidebar Contacts → sidebar
  // still shows Customers highlighted" bug where sticky state from a
  // prior Customers visit would latch onto the plain `/contacts` URL.
  const targetHasQuery = (item.to.split("?")[1] || "").length > 0;
  const currentHasQuery = (loc.search || "").length > 0;
  if (!currentHasQuery && targetHasQuery) return false;
  if (!currentHasQuery && !targetHasQuery) return true;

  // Sticky override — when the pathname has multiple sidebar entries,
  // only the last-clicked one lights up (regardless of ?type= / ?direction=).
  // Match by BOTH groupKey and label because sibling groups may share
  // an identical label (e.g. "Payments" lives in both Sales and Purchases).
  if (ITEM_PATH_COUNTS[p] > 1) {
    const s = sticky[p];
    if (s) return s.label === item.label && s.groupKey === groupKey;
    // No sticky choice yet — fall back to query-matching so a fresh
    // deep-link to `?type=customer` still highlights the right entry.
  }
  // If the item's target URL specifies query params (e.g. ?type=customer
  // or ?direction=in), require the current URL's corresponding params
  // to match — otherwise multiple sub-items sharing a pathname collide.
  const targetQuery = new URLSearchParams(item.to.split("?")[1] || "");
  if ([...targetQuery.keys()].length === 0) return true;
  const currentQuery = new URLSearchParams(loc.search || "");
  for (const [k, v] of targetQuery.entries()) {
    const cur = currentQuery.get(k);
    // If the URL has no value for this key, treat as ambiguous — no
    // sidebar item claims it (so the "all" state highlights nothing).
    if (cur === null) return false;
    if (cur !== v) return false;
  }
  return true;
};

const isGroupActive = (loc, group, sticky = {}) =>
  group.items.some((it) => isItemActive(loc, it, sticky, group.key));

function ProductAccordion({ user, product, Item, Group, showCollapsed }) {
  const rawModules = _visibleModules(user).filter(m => m.key !== "home");
  // Persisted user-chosen order (drag-and-drop). Defaults to the app's
  // natural order; missing/new modules append at the end.
  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("sb_accordion_order") || "[]");
      if (Array.isArray(saved)) return saved;
    } catch { /* ignore */ }
    return [];
  });
  useEffect(() => {
    try { localStorage.setItem("sb_accordion_order", JSON.stringify(order)); } catch { /* ignore */ }
  }, [order]);
  const modules = useMemo(() => {
    if (!order.length) return rawModules;
    const byKey = new Map(rawModules.map(m => [m.key, m]));
    const seen = new Set();
    const out = [];
    for (const k of order) {
      if (byKey.has(k) && !seen.has(k)) { out.push(byKey.get(k)); seen.add(k); }
    }
    for (const m of rawModules) if (!seen.has(m.key)) out.push(m);
    return out;
  }, [order, rawModules]);
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const commitReorder = (src, dst) => {
    if (!src || !dst || src === dst) return;
    const keys = modules.map(m => m.key);
    const from = keys.indexOf(src);
    const to = keys.indexOf(dst);
    if (from < 0 || to < 0) return;
    const next = keys.slice();
    next.splice(from, 1);
    next.splice(to, 0, src);
    setOrder(next);
  };

  // Auto-expand the currently active product; the pref is remembered
  // per-device so the accordion feels persistent between visits.
  const [openKey, setOpenKey] = useState(() => {
    try {
      const saved = localStorage.getItem("sb_accordion_open");
      if (saved && rawModules.some(m => m.key === saved)) return saved;
    } catch { /* ignore */ }
    return product;
  });
  useEffect(() => {
    try { localStorage.setItem("sb_accordion_open", openKey || ""); } catch { /* ignore */ }
  }, [openKey]);
  // Auto-expand on entry to a new product.
  const lastProd = useRef(product);
  useEffect(() => {
    if (product !== lastProd.current) {
      setOpenKey(product);
      lastProd.current = product;
    }
  }, [product]);

  const navigate = useNavigate();
  const renderKids = (key) => {
    if (key === "accounting") {
      return (
        <>
          <Item item={{ to: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true }} />
          <Item item={{ to: "/accounting/todo", label: "To Do", icon: CheckSquare, exact: true }} />
          <Group group={GROUPS[0]} />
          <Group group={GROUPS[1]} />
          <Item item={{ to: "/receipts", label: "Receipts", icon: Receipt }} />
          <Item item={{ to: "/reports", label: "Reports", icon: BarChart3 }} />
          <Item item={{ to: "/contacts", label: "Contacts", icon: Users }} />
          <Group group={GROUPS[2]} />
          <Group group={GROUPS[3]} />
        </>
      );
    }
    if (key === "projects") {
      return (
        <>
          <Item item={{ to: "/accounting/projects", label: "Dashboard", icon: LayoutDashboard, exact: true }} />
          <Item item={{ to: "/accounting/projects/list", label: "All projects", icon: Briefcase, exact: true }} />
          <Item item={{ to: "/reports/estimates-vs-actuals", label: "Estimates vs Actuals", icon: BarChart3 }} />
        </>
      );
    }
    if (key === "crm") {
      return (
        <>
          <Item item={{ to: "/crm", label: "Overview", icon: LayoutDashboard, exact: true }} />
          <Item item={{ to: "/crm/deals", label: "Deals", icon: GitBranch, exact: true }} />
          <Item item={{ to: "/crm/email", label: "Email", icon: Mail, exact: true }} />
          <Item item={{ to: "/crm/calendar", label: "Calendar", icon: CalendarCheck, exact: true }} />
          <Item item={{ to: "/contacts?product=crm", label: "Contacts", icon: Users, matchPath: "/contacts" }} />
          <Item item={{ to: "/crm/settings", label: "Settings", icon: Sparkles, exact: true }} />
        </>
      );
    }
    if (key === "team") {
      return (
        <>
          <Item item={{ to: "/team", label: "Employees", icon: Building2, exact: true }} />
          <Item item={{ to: "/team/time", label: "Time", icon: Clock, exact: true }} />
          <Item item={{ to: "/team/calendar", label: "Calendar", icon: CalendarCheck, exact: true }} />
          <Item item={{ to: "/team/approvals", label: "Approvals", icon: ClipboardCheck, exact: true }} />
        </>
      );
    }
    return null;
  };

  return (
    <div data-testid="sidebar-product-accordion">
      <Item item={{ to: "/home", label: "Home", icon: Home, exact: true, colorHex: "#6366F1" }} />
      {!showCollapsed && (
        <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          Products
        </div>
      )}
      {showCollapsed && <div className="my-2" />}
      {modules.map(m => {
        const Icon = m.icon;
        const isOpen = openKey === m.key;
        const isActive = product === m.key;
        // ---- Rail (collapsed sidebar) — icon-only row ----------------
        // In rail mode we drop the label, chevron, drag grip, and any
        // expanded children. A single clickable icon per product that
        // navigates to that product's home. Keeps the rail clean and
        // matches the compact style pros expect.
        if (showCollapsed) {
          return (
            <NavLink
              key={m.key}
              to={m.to}
              className={`mb-0.5 flex items-center justify-center p-2 rounded-lg transition-colors ${
                isActive ? "bg-slate-100" : "hover:bg-slate-50"
              }`}
              data-testid={`sidebar-accordion-${m.key}-goto`}
              title={m.label}
            >
              <Icon size={18} style={{ color: m.hex }} />
            </NavLink>
          );
        }
        return (
          <div
            key={m.key}
            className={`mb-0.5 ${dragOverKey === m.key && dragKey !== m.key ? "border-t-2 border-indigo-400" : ""}`}
            onDragOver={(e) => {
              if (!dragKey || dragKey === m.key) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverKey(m.key);
            }}
            onDragLeave={() => setDragOverKey(k => k === m.key ? null : k)}
            onDrop={(e) => {
              e.preventDefault();
              commitReorder(dragKey, m.key);
              setDragKey(null);
              setDragOverKey(null);
            }}
          >
            <div
              className={`group flex items-stretch rounded-lg overflow-hidden ${
                isActive ? "bg-slate-100" : "hover:bg-slate-50"
              } ${dragKey === m.key ? "opacity-40" : ""}`}
            >
              {/* Drag grip — the ONLY draggable region. Keeps label &
                    chevron clicks unambiguous. Ghost dots only on hover. */}
              <div
                draggable
                onDragStart={(e) => {
                  setDragKey(m.key);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", m.key);
                }}
                onDragEnd={() => { setDragKey(null); setDragOverKey(null); }}
                className="w-3 flex items-center justify-center text-slate-300 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
                data-testid={`sidebar-accordion-${m.key}-grip`}
                title="Drag to reorder"
              >
                <span className="text-[9px] leading-none select-none">⋮⋮</span>
              </div>
              {/* Label region — click behavior:
                     • Section closed → open + navigate to product home
                     • Section open   → collapse; stay on current page */}
              <button
                type="button"
                onClick={() => {
                  if (isOpen) { setOpenKey(null); return; }
                  setOpenKey(m.key);
                  navigate(m.to);
                }}
                className="flex-1 flex items-center gap-3 pl-1 pr-3 py-2 text-sm text-left"
                data-testid={`sidebar-accordion-${m.key}-goto`}
                title={isOpen ? `Collapse ${m.label}` : `Open ${m.label}`}
              >
                <Icon size={16} className="shrink-0" style={{ color: m.hex }} />
                <span className={`${isActive ? "font-semibold text-slate-900" : "text-slate-700"}`}>{m.label}</span>
              </button>
              {/* Chevron region — click to toggle expand only. */}
              <button
                type="button"
                onClick={() => setOpenKey(isOpen ? null : m.key)}
                className="px-2 flex items-center text-slate-400 hover:text-slate-700 border-l border-transparent hover:border-slate-200"
                data-testid={`sidebar-accordion-${m.key}-toggle`}
                aria-expanded={isOpen}
                title={isOpen ? "Collapse" : "Expand"}
              >
                <ChevronDown size={14} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
            {isOpen && (
              <div className="pl-2 mt-0.5 space-y-0.5 border-l-2 border-slate-100 ml-4">
                {renderKids(m.key)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


export default function Sidebar({ collapsed, onToggle }) {
  const { branding } = useBranding();
  const { isAdvancedMode, classesEnabled, projectsEnabled, budgetsEnabled } = useCompany();
  const logos = branding?.logos || {};
  // ------------------------------------------------------------------
  // Hover-to-expand: when the user has manually collapsed the sidebar
  // (rail mode), mousing over it should temporarily expand it to the
  // full 256px width; leaving snaps it back. `hoverExpanded` is the
  // transient bit that overlays the persistent `collapsed` preference.
  // We render the expanded sidebar as ABSOLUTE-positioned so the main
  // content doesn't reflow every time the pointer crosses the rail —
  // the rail always occupies 64px in the flex layout.
  // ------------------------------------------------------------------
  const [hoverExpanded, setHoverExpanded] = useState(false);
  // "More" bottom group — collapsed by default. Sticky across sessions.
  // Auto-opens once when the user first lands on a child route (so they
  // see where they are) but a manual collapse thereafter always wins.
  const [moreOpen, setMoreOpen] = useState(() => {
    try { return localStorage.getItem("sb_more_open") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sb_more_open", moreOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [moreOpen]);
  // Track the last pathname so we only auto-expand on ENTRY to a child
  // route, not on every re-render while sitting on one.
  const _lastPathRef = useRef(null);

  // -------- Sidebar search ---------------------------------------------
  const navigate = useNavigate();
  const [searchQ, setSearchQ] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const searchRef = useRef(null);
  const searchHits = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const row of SEARCH_INDEX) {
      const label = row.label.toLowerCase();
      let score = 0;
      if (label.startsWith(q)) score += 100;
      else if (label.includes(q)) score += 50;
      if (row.keywords.includes(q)) score += 25;
      if (score > 0) scored.push({ row, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label))
      .slice(0, 8)
      .map(x => x.row);
  }, [searchQ]);
  useEffect(() => { setSearchIdx(0); }, [searchQ]);
  const gotoHit = (hit) => {
    if (!hit) return;
    setSearchQ("");
    navigate(hit.to);
  };
  const _hoverTimerRef = useRef(null);
  const handleMouseEnter = () => {
    if (!collapsed) return;   // full mode is already expanded
    if (_hoverTimerRef.current) {
      clearTimeout(_hoverTimerRef.current);
      _hoverTimerRef.current = null;
    }
    setHoverExpanded(true);
  };
  const handleMouseLeave = () => {
    if (!collapsed) return;
    // Small delay so a quick pointer twitch off the edge doesn't
    // collapse before the user can click a link.
    if (_hoverTimerRef.current) clearTimeout(_hoverTimerRef.current);
    _hoverTimerRef.current = setTimeout(() => setHoverExpanded(false), 180);
  };
  useEffect(() => () => {
    if (_hoverTimerRef.current) clearTimeout(_hoverTimerRef.current);
  }, []);
  // "Collapsed as far as the RENDER is concerned" — false whenever the
  // user is hovering the rail even if the persisted state is collapsed.
  const showCollapsed = collapsed && !hoverExpanded;
  const logoUrl = showCollapsed
    ? (logos.icon_light || logos.logo_light || branding?.logo_data_url)
    : (logos.logo_light || logos.icon_light || branding?.logo_data_url);
  const { user } = useAuth();
  const loc = useLocation();
  const product = detectProduct(loc.pathname, loc.search);
  const [navStyle] = useNavStyle();
  // Sticky item map: pathname -> {groupKey, label}. Updated whenever
  // the user clicks a sidebar entry that shares a path with another.
  const [sticky, setSticky] = useState(readSticky);
  useEffect(() => {
    const refresh = () => setSticky(readSticky());
    window.addEventListener(STICKY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(STICKY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Persist per-group open/closed state across navigations. Auto-open the
  // group that contains the current route.
  const initialOpen = () => {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("sb_nav_open") || "{}"); } catch {}
    const merged = { ...stored };
    for (const g of GROUPS) {
      if (isGroupActive(loc, g, sticky)) merged[g.key] = true;
      if (!(g.key in merged)) merged[g.key] = false;
    }
    return merged;
  };
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    localStorage.setItem("sb_nav_open", JSON.stringify(open));
  }, [open]);
  // Re-check on route change so navigating into a group auto-expands it.
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of GROUPS) {
        if (isGroupActive(loc, g, sticky) && !next[g.key]) { next[g.key] = true; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [loc.pathname, loc.search, sticky]);

  const toggleGroup = (k) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  const Item = ({ item, group, indent = false }) => {
    const active = isItemActive(loc, item, sticky, group?.key || null);
    const Icon = item.icon;
    return (
      <NavLink
        to={item.to}
        onClick={() => { if (group) rememberSticky(group, item); }}
        data-testid={`${TID.navLink}-${item.label.replace(/\s+/g, "-").toLowerCase()}`}
        className={`nav-item flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
          active ? "nav-item-active" : "text-slate-700"
        } ${indent && !showCollapsed ? "pl-9" : ""}`}
      >
        <Icon size={16} style={{ color: item.colorHex || NAV_COLOR }} strokeWidth={2} />
        {!showCollapsed && <span className="truncate">{item.label}</span>}
      </NavLink>
    );
  };

  const Group = ({ group }) => {
    const opened = !!open[group.key];
    const Icon = group.icon;
    return (
      <div className="mt-1">
        <button
          onClick={() => toggleGroup(group.key)}
          className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
            isGroupActive(loc, group, sticky) ? "text-slate-900 font-medium" : "text-slate-700"
          } hover:bg-slate-50`}
          data-testid={`${TID.navGroup}-${group.key}`}
          aria-expanded={opened}
        >
          <Icon size={16} style={{ color: NAV_COLOR }} strokeWidth={2} />
          {!showCollapsed && (
            <>
              <span className="truncate">{group.label}</span>
              <span className="ml-auto text-slate-400">
                {opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </>
          )}
        </button>
        {opened && !showCollapsed && (
          <div className="mt-0.5 space-y-0.5">
            {group.items
              // Hide advanced-only items (Sales Receipts, Credit Memos)
              // when the company is in "simple" accounting mode. Keeps
              // the sidebar uncluttered for regular business owners.
              .filter((it) => isAdvancedMode || !it.advancedOnly)
              // Advanced-features nav items (Feb 2026 Phase 2) —
              // hide unless the matching company flag is on. Same
              // pattern as `advancedOnly`, per-flag key.
              .filter((it) => classesEnabled || !it.classesEnabledOnly)
              .filter((it) => projectsEnabled || !it.projectsEnabledOnly)
              .filter((it) => budgetsEnabled || !it.budgetsEnabledOnly)
              // Hide superadmin-only items (Test QBO raw migration
              // workbench) from every non-superadmin persona so pros,
              // partners, and clients don't see internal tooling.
              .filter((it) => !it.superadminOnly || user?.role === "superadmin")
              .map((it) => (
                <Item key={it.label} item={it} group={group} indent />
              ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className={`shrink-0 border-r bg-white transition-all duration-300 flex flex-col ${
        // Width follows the EFFECTIVE state (persistent + hover), so
        // hovering over the rail expands the sidebar in-place and the
        // main content reflows to the right instead of being covered.
        showCollapsed ? "w-16" : "w-64"
      }`}
      data-testid="app-sidebar"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="h-16 shrink-0 flex items-center gap-2 px-2 border-b">
        {logoUrl ? (
          <img
            src={logoUrl} alt="Firm logo"
            className={showCollapsed
              ? "h-12 w-12 object-contain"
              : "h-14 max-w-[210px] object-contain object-left flex-1 min-w-0"}
            data-testid="sidebar-firm-logo"
          />
        ) : (
          <>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-600 text-white shrink-0">
              <Sparkles size={16} />
            </div>
            {!showCollapsed && (
              <div className="min-w-0">
                {/* Firm name from branding.firm_name wins when the branding
                    cascade returned an unlocked brand for this user (their
                    own, or an inherited Partner / Enterprise). Falls back
                    to the platform "SmartBooks / Ledger" wordmark. */}
                {branding?.firm_name ? (
                  <div
                    className="font-heading font-bold text-slate-900 leading-tight truncate"
                    title={branding.firm_name}
                    data-testid="sidebar-firm-name"
                  >
                    {branding.firm_name}
                  </div>
                ) : (
                  <>
                    <div className="font-heading font-bold text-slate-900 leading-tight">SmartBooks</div>
                    <div className="text-[10px] tracking-widest uppercase text-slate-500 leading-tight">Ledger</div>
                  </>
                )}
              </div>
            )}
          </>
        )}
        <button
          data-testid={TID.sidebarToggle}
          onClick={() => {
            // Reset the transient hover-expanded flag before flipping
            // the persistent collapsed state — otherwise pinning the
            // sidebar open while hovering leaves the overlay classes
            // stuck on, obscuring the content below.
            setHoverExpanded(false);
            if (_hoverTimerRef.current) {
              clearTimeout(_hoverTimerRef.current);
              _hoverTimerRef.current = null;
            }
            onToggle();
          }}
          className="ml-auto p-1.5 text-slate-500 hover:bg-slate-100 rounded"
          title="Toggle sidebar"
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {/* Sidebar search — type-to-jump. Hidden in rail mode (no room
             for a real input); Cmd/Ctrl+K auto-expands the rail via
             focus and gives the user a text box. */}
        {!showCollapsed && (
          <div className="relative mb-2" data-testid="sidebar-search">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              ref={searchRef}
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSearchIdx(i => Math.min(i + 1, searchHits.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setSearchIdx(i => Math.max(i - 1, 0)); }
                else if (e.key === "Enter" && searchHits.length > 0) { e.preventDefault(); gotoHit(searchHits[searchIdx]); }
                else if (e.key === "Escape") { e.preventDefault(); setSearchQ(""); e.currentTarget.blur(); }
              }}
              placeholder="Search — try “aging”, “tax”, “bills”"
              className="w-full pl-7 pr-2 py-1.5 rounded-md border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:border-slate-400 focus:ring-1 focus:ring-slate-400 outline-none"
              data-testid="sidebar-search-input"
            />
            {searchQ && (
              <div
                className="absolute left-0 right-0 top-full mt-1 rounded-md border bg-white shadow-lg z-40 max-h-72 overflow-y-auto"
                data-testid="sidebar-search-results"
              >
                {searchHits.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-500">No matches</div>
                )}
                {searchHits.map((hit, i) => (
                  <button
                    key={`${hit.to}-${hit.label}`}
                    onClick={() => gotoHit(hit)}
                    onMouseEnter={() => setSearchIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 ${
                      i === searchIdx ? "bg-slate-100" : "hover:bg-slate-50"
                    }`}
                    data-testid={`sidebar-search-result-${i}`}
                  >
                    <span className="truncate text-slate-800">{hit.label}</span>
                    {hit.groupLabel && (
                      <span className="text-[10px] text-slate-400 shrink-0">{hit.groupLabel}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Role-specific top links */}
        {user?.role === "superadmin" && (
          <Item item={{ to: "/admin", label: "Superadmin", icon: Shield }} />
        )}
        {/* Superadmin: "Clients" sits directly under Superadmin so
            the platform-wide client roster is one click from the
            top-of-nav (Round 7.20, Feb 2026). */}
        {user?.role === "superadmin" && (
          <Item item={{
            to: "/pro/clients",
            label: user?.enterprise_id ? "Enterprise Clients" : "Clients",
            icon: Briefcase,
          }} />
        )}
        {user?.role === "superadmin" && (
          <Item item={{ to: "/admin/usage", label: "Usage & Costs", icon: Activity }} />
        )}
        {/* Product Launch — superadmin control panel for gating each
            product on/off per user cohort. Sits right below Usage &
            Costs (Round 7.21, Feb 2026). */}
        {user?.role === "superadmin" && (
          <Item item={{ to: "/admin/product-launches", label: "Product Launch", icon: Rocket }} />
        )}
        {/* Partner top link — their own scoped dashboard with the
            "My Clients" section (Clients | Enterprises toggle). Sits
            in the same slot Superadmin uses so the top-of-nav pattern
            reads consistently across roles. */}
        {user?.role === "partner" && (
          <Item item={{ to: "/partner", label: "Partner Dashboard", icon: Shield }} />
        )}
        {(user?.role === "pro" || user?.role === "partner") && (
          <Item item={{
            to: user?.role === "partner" ? "/partner" : "/pro/clients",
            // Partner-context and enterprise-context users get a
            // qualified label so the sidebar signals which "clients"
            // list this is: their partner tree, an enterprise's client
            // roster, or a plain Pro's book of business.
            label: user?.role === "partner"
              ? "Partner Clients"
              : user?.enterprise_id
                ? "Enterprise Clients"
                : "Clients",
            icon: Briefcase,
          }} />
        )}

        {/* Cockpit — cross-client command surface. Shows only for
            firm/pro/admin/partner/superadmin roles (backend rejects
            single-book client-owners with 403). Sits directly BELOW
            the Clients/Enterprise Clients link so the roster is the
            first thing firm users see (Feb 2026 tweak).
            Uses `canUseCockpit` so a transient /auth/me payload that
            drops `role` doesn't hide the link mid-session. */}
        {canUseCockpit(user) && (
          <Item item={{
            to: "/cockpit",
            label: "Cockpit",
            icon: Aperture,
            matchPath: "/cockpit",
          }} />
        )}

        {/* Per-company Client Cockpit — same firm-role gate as the
            firm-wide Cockpit above. Opens straight into a control-room
            view of whichever client is currently selected in the top
            switcher (Feb 2026). */}
        {canUseCockpit(user) && (
          <Item item={{
            to: "/cockpit/client",
            label: "Client Cockpit",
            icon: Activity,
            matchPath: "/cockpit/client",
          }} />
        )}

        {/* Partner Financials — sits directly under "Partner Clients"
            as its own top-level nav. Superadmin has its own
            "Usage & Costs" entry higher up; partners get a scoped
            copy of that same page here. */}
        {user?.role === "partner" && (
          <Item item={{
            to: "/partner/financials",
            label: "Partner Financials",
            icon: Activity,
          }} />
        )}

        {/* Context nav header — inside Accounting we still render an
             "Overview" link at the top of the sidebar because it
             belongs to that product. Every other product shell gets a
             tiny "← Home" breadcrumb chip that pops the user back to
             the cross-product platform home. On /home itself the
             chip is suppressed (self-link) — the rail's Home icon is
             the affordance. */}
        {navStyle === "accordion" ? (
          <ProductAccordion
            user={user}
            product={product}
            Item={Item}
            Group={Group}
            showCollapsed={showCollapsed}
          />
        ) : product === "accounting" ? (
          <>
            {/* In menu / dropdown mode there's no rail — surface a
                module switcher so users can jump elsewhere without
                losing the current page. */}
            {navStyle === "menu"     && <ModulesSwitcher user={user} />}
            {navStyle === "dropdown" && <ModulesDropdown activeKey={product} collapsed={showCollapsed} user={user} />}
            <Item item={ACCOUNTING_TOP} />
          </>
        ) : product === "home" ? (
          (navStyle === "menu" || navStyle === "dropdown") ? (
            <div data-testid="sidebar-home-modules">
              {/* Home anchor + colored module list (Round 7.12).
                  Filtered to `enabled_products` (Round 7.21) so users
                  only see modules they have access to. */}
              <Item item={{ to: "/home", label: "Home", icon: Home, exact: true, colorHex: "#6366F1" }} />
              {_visibleModules(user)
                .filter(m => m.key !== "home")
                .map(m => (
                  <Item key={m.key}
                    item={{ to: m.to, label: m.label, icon: m.icon, colorHex: m.hex }} />
                ))}
            </div>
          ) : (
            <div className="mx-3 mb-2 mt-1 rounded-md bg-indigo-50 border border-indigo-100 p-2 text-[10px] text-indigo-700 leading-snug"
                  data-testid="sidebar-home-hint">
              <span className="font-semibold uppercase tracking-wider">Home</span>
              <div className="mt-0.5 text-indigo-600/80">
                Jump into a product from the rail →
              </div>
            </div>
          )
        ) : (
          navStyle === "menu" ? (
            <ModulesSwitcher user={user} />
          ) : navStyle === "dropdown" ? (
            <ModulesDropdown activeKey={product} collapsed={showCollapsed} user={user} />
          ) : (
            <NavLink to="/home"
                      data-testid="sidebar-home-breadcrumb"
                      className="mx-3 mb-1 mt-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-slate-400 hover:text-slate-700 transition"
                      title="Back to platform home">
              <ArrowLeft size={10} /> Home
            </NavLink>
          )
        )}

        {navStyle !== "accordion" && product === "accounting" && (
          <>
            {/* Grouped: Sales & Payments */}
            <Group group={GROUPS[0]} />
            {/* Grouped: Purchases */}
            <Group group={GROUPS[1]} />
            {/* Receipts (single, between purchases and banking) */}
            {AFTER_PURCHASES.map((it) => <Item key={it.label} item={it} />)}
            {/* Reports + Contacts — top-level (Projects moved to its
                own product; hidden from this list) */}
            {AFTER_BANKING
              .filter((it) => !it.projectsEnabledOnly)
              .map((it) => <Item key={it.label} item={it} />)}
            {/* Grouped: Accounting */}
            <Group group={GROUPS[3]} />

            {/* Communications kept discoverable (previously top-level) */}
            <Item item={{ to: "/communications", label: "Communications", icon: Inbox }} />

            {/* Grouped: Banking — moved BELOW Communications so daily
                workflows (transactions, reports, comms) sit at the top of
                the nav and the connection-management group lives closer
                to Settings, matching how often each is actually used. */}
            <Group group={GROUPS[2]} />

            {/* Accounting sub-page settings — Round 7.7 (Feb 2026).
                Placed right after the Connect & Import group so the
                shell mirrors CRM's own Settings link. */}
            <Item item={{ to: "/accounting/settings", label: "Settings", icon: Settings2, exact: true }} />
          </>
        )}

        {navStyle !== "accordion" && product === "projects" && (
          <>
            <Item item={{ to: "/accounting/projects", label: "Dashboard", icon: LayoutDashboard, exact: true }} />
            <Item item={{ to: "/accounting/projects/list", label: "All projects", icon: Briefcase, exact: true }} />
            <Item item={{ to: "/reports/estimates-vs-actuals", label: "Estimates vs Actuals", icon: BarChart3 }} />
          </>
        )}

        {navStyle !== "accordion" && product === "crm" && (
          <>
            <Item item={{ to: "/crm", label: "Overview", icon: LayoutDashboard, exact: true }} />
            <Item item={{ to: "/crm/deals", label: "Deals", icon: GitBranch, exact: true }} />
            <Item item={{ to: "/crm/email", label: "Email", icon: Mail, exact: true }} />
            <Item item={{ to: "/crm/calendar", label: "Calendar", icon: CalendarCheck, exact: true }} />
            <Item item={{ to: "/contacts?product=crm", label: "Contacts", icon: Users, matchPath: "/contacts" }} />
            <Item item={{ to: "/crm/settings", label: "Settings", icon: Sparkles, exact: true }} />
          </>
        )}

        {navStyle !== "accordion" && product === "team" && (
          <>
            <Item item={{ to: "/team", label: "Employees", icon: Building2, exact: true }} />
            <Item item={{ to: "/team/time", label: "Time", icon: Clock, exact: true }} />
            <Item item={{ to: "/team/calendar", label: "Calendar", icon: CalendarCheck, exact: true }} />
            <Item item={{ to: "/team/approvals", label: "Approvals", icon: ClipboardCheck, exact: true }} />
            <div className="mt-3 mx-3 rounded-md bg-emerald-50 border border-emerald-200 p-2 text-[10px] text-emerald-800 leading-snug">
              Tasks work today — try ⌘⇧T anywhere. Global search is ⌘K.
            </div>
          </>
        )}

        <div className="my-4 border-t" />

        {/* "More" — collapsible group containing the standalone
             bottom-nav links (My Businesses, Billing, Refer & earn,
             Settings). Rendered inline (rather than as a separate
             component) so it can share the `Item` renderer and the
             active-path highlight logic without prop drilling.
             Auto-opens when the current path is one of the children,
             falling back to the persisted `moreOpen` preference. */}
        {(() => {
          const bottomItems = STANDALONE_BOTTOM.map((it) =>
            (it.to === "/settings" && product !== "accounting")
              ? { ...it, to: `/settings?product=${product}` }
              : it,
          );
          const activeChild = bottomItems.some(it =>
            loc.pathname.startsWith(it.to.split("?")[0])
          );
          // Auto-expand ONLY on entry to a child route (pathname
          // change from a non-child to a child). Manual collapse
          // always wins afterwards.
          const prev = _lastPathRef.current;
          if (loc.pathname !== prev) {
            const wasOnChild = prev && bottomItems.some(it => prev.startsWith(it.to.split("?")[0]));
            if (activeChild && !wasOnChild && !moreOpen) {
              // Defer to next tick so we don't setState during render.
              setTimeout(() => setMoreOpen(true), 0);
            }
            _lastPathRef.current = loc.pathname;
          }
          const open = moreOpen;
          const label = "More";
          return (
            <>
              <button
                type="button"
                onClick={() => setMoreOpen(v => !v)}
                title={showCollapsed ? label : undefined}
                data-testid="sidebar-more-toggle"
                aria-expanded={open}
                className={`w-full flex items-center gap-3 rounded-lg text-sm text-slate-700 hover:bg-slate-50 transition-colors ${
                  showCollapsed ? "justify-center p-2" : "px-3 py-2"
                } ${activeChild ? "bg-slate-100 text-slate-900 font-medium" : ""}`}
              >
                <MoreHorizontal size={16} className="shrink-0" />
                {!showCollapsed && (
                  <>
                    <span className="flex-1 text-left">{label}</span>
                    <ChevronDown
                      size={14}
                      className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </>
                )}
              </button>
              {open && !showCollapsed && (
                <div className="mt-0.5 space-y-0.5" data-testid="sidebar-more-panel">
                  {bottomItems.map((it) => (
                    <Item key={it.label} item={it} indent />
                  ))}
                </div>
              )}
              {open && showCollapsed && (
                // Rail mode: still show the items directly (no indent
                // since there's no room for the visual hierarchy).
                <div className="mt-0.5 space-y-0.5">
                  {bottomItems.map((it) => (
                    <Item key={it.label} item={it} />
                  ))}
                </div>
              )}
            </>
          );
        })()}
      </nav>

      {/* Insights Chat launcher — sits directly above user info so it's
          always one click away without cluttering the bottom-right of
          the app. Fires the same global event the widget itself listens
          for so we keep a single source of truth for the panel. */}
      <div className={`px-2 ${showCollapsed ? "pb-2" : "pb-1"}`}>
        <button
          onClick={() => window.dispatchEvent(new Event("insights:open"))}
          data-testid="sidebar-insights-chat-btn"
          title="Ask about my data"
          className={`w-full flex items-center gap-2 rounded-lg border border-indigo-200 bg-gradient-to-br from-indigo-50 to-fuchsia-50 hover:from-indigo-100 hover:to-fuchsia-100 transition-colors ${
            showCollapsed ? "justify-center p-2" : "px-3 py-2"
          }`}
        >
          <span className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-600 to-fuchsia-600 grid place-items-center text-white shrink-0">
            <Sparkles size={12} />
          </span>
          {!showCollapsed && (
            <span className="text-xs font-medium text-indigo-900 truncate">
              Ask about my data
            </span>
          )}
        </button>
      </div>

      {!showCollapsed && (
        <div className="p-3 border-t text-[11px] text-slate-500">
          <div className="font-heading font-semibold text-slate-700">{user?.name}</div>
          <div className="truncate">{user?.email}</div>
          <div className="mt-1 inline-block px-1.5 py-0.5 rounded bg-slate-100 uppercase tracking-wide text-slate-600">{user?.role}</div>
        </div>
      )}
    </aside>
  );
}
