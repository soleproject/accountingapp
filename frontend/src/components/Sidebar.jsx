import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, FileText, Receipt, CreditCard, ScrollText, BarChart3,
  Users, Link2, Inbox, ChevronDown, ChevronRight, ArrowLeftRight, Boxes,
  Building2, Wallet, Tags, CheckCheck, ClipboardCheck, CalendarCheck, Calendar,
  BookOpen, Notebook, ListTree, Sparkles, Shield, Briefcase, Wand2,
  PanelLeftClose, PanelLeft, Settings2, Share2, Activity, Repeat, Package,
  MailCheck, UserCircle, Store, Landmark, Download, ShoppingCart, Coins,
  Percent, Lock,
} from "lucide-react";
import { TID } from "@/constants/testIds";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";

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
      { to: "/invoices", label: "Invoices", icon: FileText },
      { to: "/payments?direction=in", label: "Payments", icon: CreditCard, matchPath: "/payments" },
      { to: "/items?usage=sales", label: "Items", icon: Package, matchPath: "/items" },
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
      { to: "/bills", label: "Bills", icon: Receipt },
      { to: "/payments?direction=out", label: "Payments", icon: CreditCard, matchPath: "/payments" },
      { to: "/items?usage=purchases", label: "Items", icon: Package, matchPath: "/items" },
      { to: "/contacts?type=vendor", label: "Vendors", icon: Store, matchPath: "/contacts" },
    ],
  },
  {
    key: "banking",
    label: "Banking",
    icon: Landmark,
    items: [
      { to: "/connections", label: "Connect Accounts", icon: Link2 },
      { to: "/connections?view=imports", label: "Import Statements", icon: Download, matchPath: "/connections" },
    ],
  },
  {
    key: "accounting",
    label: "Accounting",
    icon: ListTree,
    items: [
      { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
      { to: "/accounting/chart-of-accounts", label: "Chart of Accounts", icon: ListTree },
      { to: "/accounting/assets", label: "Assets", icon: Building2 },
      { to: "/accounting/loans", label: "Loans", icon: Wallet },
      { to: "/inventory-management", label: "Inventory", icon: Boxes, matchPath: "/inventory-management" },
      { to: "/accounting/tags", label: "Tags", icon: Tags },
      { to: "/accounting/reconciliation", label: "Reconciliation", icon: CheckCheck },
      { to: "/accounting/journal-entries", label: "Journal Entries", icon: BookOpen },
      { to: "/accounting/general-ledger", label: "General Ledger", icon: Notebook },
      { to: "/accounting/taxes", label: "Tax Library", icon: Percent },
      { to: "/accounting/ai-cleanup-review", label: "AI Cleanup Review", icon: Sparkles },
      { to: "/accounting/rules", label: "AI Rules", icon: Wand2 },
      { to: "/accounting/book-review", label: "Book Review", icon: ClipboardCheck },
      { to: "/accounting/month-close", label: "Month Close", icon: CalendarCheck },
      { to: "/accounting/close-books", label: "Close the Books", icon: Lock },
    ],
  },
];

/** Standalone (non-grouped) links, in the exact order specified. */
const STANDALONE_TOP = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
];
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
];
// After accounting group:
const STANDALONE_BOTTOM = [
  { to: "/my-businesses", label: "My Businesses", icon: Briefcase },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/share", label: "Refer & earn", icon: Share2 },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

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
  const pathHit = loc.pathname === p || loc.pathname.startsWith(p + "/");
  if (!pathHit) return false;
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

export default function Sidebar({ collapsed, onToggle }) {
  const { branding } = useBranding();
  const logos = branding?.logos || {};
  const logoUrl = collapsed
    ? (logos.icon_light || logos.logo_light || branding?.logo_data_url)
    : (logos.logo_light || logos.icon_light || branding?.logo_data_url);
  const { user } = useAuth();
  const loc = useLocation();
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
        } ${indent && !collapsed ? "pl-9" : ""}`}
      >
        <Icon size={16} style={{ color: NAV_COLOR }} strokeWidth={2} />
        {!collapsed && <span className="truncate">{item.label}</span>}
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
          {!collapsed && (
            <>
              <span className="truncate">{group.label}</span>
              <span className="ml-auto text-slate-400">
                {opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </>
          )}
        </button>
        {opened && !collapsed && (
          <div className="mt-0.5 space-y-0.5">
            {group.items.map((it) => (
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
        collapsed ? "w-16" : "w-64"
      }`}
      data-testid="app-sidebar"
    >
      <div className="h-16 shrink-0 flex items-center gap-2 px-2 border-b">
        {logoUrl ? (
          <img
            src={logoUrl} alt="Firm logo"
            className={collapsed
              ? "h-12 w-12 object-contain"
              : "h-14 max-w-[210px] object-contain object-left flex-1 min-w-0"}
            data-testid="sidebar-firm-logo"
          />
        ) : (
          <>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-600 text-white shrink-0">
              <Sparkles size={16} />
            </div>
            {!collapsed && (
              <div>
                <div className="font-heading font-bold text-slate-900 leading-tight">SmartBooks</div>
                <div className="text-[10px] tracking-widest uppercase text-slate-500 leading-tight">Ledger</div>
              </div>
            )}
          </>
        )}
        <button
          data-testid={TID.sidebarToggle}
          onClick={onToggle}
          className="ml-auto p-1.5 text-slate-500 hover:bg-slate-100 rounded"
          title="Toggle sidebar"
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {/* Role-specific top links */}
        {user?.role === "superadmin" && (
          <Item item={{ to: "/admin", label: "Superadmin", icon: Shield }} />
        )}
        {user?.role === "superadmin" && (
          <Item item={{ to: "/admin/usage", label: "Usage & Costs", icon: Activity }} />
        )}
        {(user?.role === "pro" || user?.role === "superadmin") && (
          <Item item={{ to: "/pro/clients", label: "Clients", icon: Briefcase }} />
        )}

        {/* Dashboard */}
        {STANDALONE_TOP.map((it) => <Item key={it.label} item={it} />)}

        {/* Grouped: Sales & Payments */}
        <Group group={GROUPS[0]} />
        {/* Grouped: Purchases */}
        <Group group={GROUPS[1]} />
        {/* Receipts (single, between purchases and banking) */}
        {AFTER_PURCHASES.map((it) => <Item key={it.label} item={it} />)}
        {/* Grouped: Banking */}
        <Group group={GROUPS[2]} />
        {/* Reports (single, between banking and accounting) */}
        {AFTER_BANKING.map((it) => <Item key={it.label} item={it} />)}
        {/* Grouped: Accounting */}
        <Group group={GROUPS[3]} />

        {/* Communications kept discoverable (previously top-level) */}
        <Item item={{ to: "/communications", label: "Communications", icon: Inbox }} />

        <div className="my-2 border-t" />

        {/* Bottom standalone */}
        {STANDALONE_BOTTOM.map((it) => <Item key={it.label} item={it} />)}
      </nav>

      {/* Insights Chat launcher — sits directly above user info so it's
          always one click away without cluttering the bottom-right of
          the app. Fires the same global event the widget itself listens
          for so we keep a single source of truth for the panel. */}
      <div className={`px-2 ${collapsed ? "pb-2" : "pb-1"}`}>
        <button
          onClick={() => window.dispatchEvent(new Event("insights:open"))}
          data-testid="sidebar-insights-chat-btn"
          title="Ask about my data"
          className={`w-full flex items-center gap-2 rounded-lg border border-indigo-200 bg-gradient-to-br from-indigo-50 to-fuchsia-50 hover:from-indigo-100 hover:to-fuchsia-100 transition-colors ${
            collapsed ? "justify-center p-2" : "px-3 py-2"
          }`}
        >
          <span className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-600 to-fuchsia-600 grid place-items-center text-white shrink-0">
            <Sparkles size={12} />
          </span>
          {!collapsed && (
            <span className="text-xs font-medium text-indigo-900 truncate">
              Ask about my data
            </span>
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="p-3 border-t text-[11px] text-slate-500">
          <div className="font-heading font-semibold text-slate-700">{user?.name}</div>
          <div className="truncate">{user?.email}</div>
          <div className="mt-1 inline-block px-1.5 py-0.5 rounded bg-slate-100 uppercase tracking-wide text-slate-600">{user?.role}</div>
        </div>
      )}
    </aside>
  );
}
