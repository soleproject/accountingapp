import { NavLink, useLocation } from "react-router-dom";
import { useState } from "react";
import {
  LayoutDashboard, FileText, Receipt, CreditCard, ScrollText, BarChart3,
  Users, Link2, Inbox, ChevronRight, ArrowLeft, ArrowLeftRight, Boxes,
  Building2, Wallet, Tags, CheckCheck, ClipboardCheck, CalendarCheck, Calendar,
  BookOpen, Notebook, ListTree, Sparkles, Shield, Briefcase, Wand2, PanelLeftClose, PanelLeft, Settings2, Share2, Activity,
} from "lucide-react";
import { TID } from "@/constants/testIds";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";

const NAV_COLOR = "#64748B"; // single unified slate color for all left-nav icons

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/invoices", label: "Invoices", icon: FileText },
  { to: "/bills", label: "Bills", icon: Receipt },
  { to: "/payments", label: "Payments", icon: CreditCard },
  { to: "/receipts", label: "Receipts", icon: ScrollText },
  { to: "/reports", label: "Reports", icon: BarChart3 },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/connections", label: "Connections", icon: Link2 },
  { to: "/communications", label: "Communications", icon: Inbox },
  { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/accounting/month-close", label: "Month Close", icon: CalendarCheck },
  { to: "/my-businesses", label: "My Businesses", icon: Briefcase },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/share", label: "Refer & earn", icon: Share2 },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

const ACCOUNTING = [
  { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/accounting/month-close", label: "Month Close", icon: CalendarCheck },
  { to: "/accounting/inventory", label: "Inventory", icon: Boxes },
  { to: "/accounting/assets", label: "Assets", icon: Building2 },
  { to: "/accounting/loans", label: "Loans", icon: Wallet },
  { to: "/accounting/tags", label: "Tags", icon: Tags },
  { to: "/accounting/reconciliation", label: "Reconciliation", icon: CheckCheck },
  { to: "/accounting/book-review", label: "Book Review", icon: ClipboardCheck },
  { to: "/accounting/close-books", label: "Close the Books", icon: CalendarCheck },
  { to: "/accounting/year-end", label: "Year-End Close", icon: Calendar },
  { to: "/accounting/chart-of-accounts", label: "Chart of Accounts", icon: ListTree },
  { to: "/accounting/journal-entries", label: "Journal Entries", icon: BookOpen },
  { to: "/accounting/general-ledger", label: "General Ledger", icon: Notebook },
  { to: "/accounting/rules", label: "AI Rules", icon: Wand2 },
];

export default function Sidebar({ collapsed, onToggle }) {
  const [inAccounting, setInAccounting] = useState(false);
  const { branding } = useBranding();
  // Prefer the compact "icon" mark when the sidebar is collapsed; fall back
  // to the wordmark if only one has been uploaded.
  const logos = branding?.logos || {};
  const logoUrl = collapsed
    ? (logos.icon_light || logos.logo_light || branding?.logo_data_url)
    : (logos.logo_light || logos.icon_light || branding?.logo_data_url);
  const { user } = useAuth();
  const loc = useLocation();

  // Note: we deliberately do NOT auto-enter the Accounting sub-view when the
  // route is under /accounting/*. Some accounting pages (Transactions) also
  // live directly in the main sidebar. If a user clicks Transactions from
  // the main menu, they expect the main menu to stay put; the Accounting
  // sub-view opens only when they explicitly click the "Accounting" button.

  const Item = ({ to, label, icon: Icon, color = NAV_COLOR, indent = false }) => {
    const active = loc.pathname === to || loc.pathname.startsWith(to + "/");
    return (
      <NavLink
        to={to}
        data-testid={`${TID.navLink}-${label.replace(/\s+/g, '-').toLowerCase()}`}
        className={`nav-item flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
          active ? "nav-item-active" : "text-slate-700"
        } ${indent ? "pl-8" : ""}`}
      >
        <Icon size={17} style={{ color }} strokeWidth={2} />
        {!collapsed && <span className="truncate">{label}</span>}
      </NavLink>
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
            src={logoUrl}
            alt="Firm logo"
            // Fill the ~64px-tall header aggressively — customers upload their
            // brand and expect it to feel like theirs. h-14 leaves ~4px above
            // and below; max-w-[210px] lets a wide wordmark spread while
            // still leaving room for the collapse toggle at the right.
            className={
              collapsed
                ? "h-12 w-12 object-contain"
                : "h-14 max-w-[210px] object-contain object-left flex-1 min-w-0"
            }
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
        {inAccounting ? (
          <>
            <button
              data-testid="sidebar-back-btn"
              onClick={() => setInAccounting(false)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-50 text-slate-700 border border-slate-200 mb-2"
            >
              <ArrowLeft size={15} style={{ color: NAV_COLOR }} />
              {!collapsed && <span className="font-medium">Back to main menu</span>}
            </button>
            {!collapsed && (
              <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                Accounting
              </div>
            )}
            {ACCOUNTING.map((a) => <Item key={a.to} {...a} />)}
          </>
        ) : (
          <>
            {user?.role === "superadmin" && (
              <Item to="/admin" label="Superadmin" icon={Shield} />
            )}
            {user?.role === "superadmin" && (
              <Item to="/admin/usage" label="Usage & Costs" icon={Activity} />
            )}
            {(user?.role === "pro" || user?.role === "superadmin") && (
              <Item to="/pro/clients" label="Clients" icon={Briefcase} />
            )}

            {NAV.map((n) => (
              <Item key={n.to} {...n} />
            ))}

            <button
              data-testid={`${TID.navGroup}-accounting`}
              onClick={() => setInAccounting(true)}
              className="mt-2 w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md hover:bg-slate-50 text-slate-700"
            >
              <ListTree size={17} style={{ color: NAV_COLOR }} />
              {!collapsed && (
                <>
                  <span className="font-medium">Accounting</span>
                  <span className="ml-auto"><ChevronRight size={14} /></span>
                </>
              )}
            </button>
          </>
        )}
      </nav>

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
