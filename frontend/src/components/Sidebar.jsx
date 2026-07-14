import { NavLink, useLocation } from "react-router-dom";
import { useState } from "react";
import {
  LayoutDashboard, FileText, Receipt, CreditCard, ScrollText, BarChart3,
  Users, Link2, Inbox, ChevronDown, ChevronRight, ArrowLeftRight, Boxes,
  Building2, Wallet, Tags, CheckCheck, ClipboardCheck, CalendarCheck, Calendar,
  BookOpen, Notebook, ListTree, Sparkles, Shield, Briefcase, Wand2, PanelLeftClose, PanelLeft,
} from "lucide-react";
import { TID } from "@/constants/testIds";
import { useAuth } from "@/lib/auth";

const NAV = [
  { to: "/dashboard", label: "Pulse", icon: LayoutDashboard, color: "#6366F1" },
  { to: "/invoices", label: "Invoices", icon: FileText, color: "#10B981" },
  { to: "/bills", label: "Bills", icon: Receipt, color: "#F97316" },
  { to: "/payments", label: "Payments", icon: CreditCard, color: "#22C55E" },
  { to: "/receipts", label: "Receipts", icon: ScrollText, color: "#F97316" },
  { to: "/reports", label: "Reports", icon: BarChart3, color: "#8B5CF6" },
  { to: "/contacts", label: "Contacts", icon: Users, color: "#F43F5E" },
  { to: "/connections", label: "Connections", icon: Link2, color: "#06B6D4" },
  { to: "/communications", label: "Communications", icon: Inbox, color: "#8B5CF6" },
];

const ACCOUNTING = [
  { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight, color: "#8B5CF6" },
  { to: "/accounting/inventory", label: "Inventory", icon: Boxes, color: "#8B5CF6" },
  { to: "/accounting/assets", label: "Assets", icon: Building2, color: "#EAB308" },
  { to: "/accounting/loans", label: "Loans", icon: Wallet, color: "#F97316" },
  { to: "/accounting/tags", label: "Tags", icon: Tags, color: "#10B981" },
  { to: "/accounting/reconciliation", label: "Reconciliation", icon: CheckCheck, color: "#10B981" },
  { to: "/accounting/book-review", label: "Book Review", icon: ClipboardCheck, color: "#F97316" },
  { to: "/accounting/close-books", label: "Close the Books", icon: CalendarCheck, color: "#10B981" },
  { to: "/accounting/year-end", label: "Year-End Close", icon: Calendar, color: "#10B981" },
  { to: "/accounting/chart-of-accounts", label: "Chart of Accounts", icon: ListTree, color: "#3B82F6" },
  { to: "/accounting/journal-entries", label: "Journal Entries", icon: BookOpen, color: "#8B5CF6" },
  { to: "/accounting/general-ledger", label: "General Ledger", icon: Notebook, color: "#8B5CF6" },
  { to: "/accounting/rules", label: "AI Rules", icon: Wand2, color: "#6366F1" },
];

export default function Sidebar({ collapsed, onToggle }) {
  const [accOpen, setAccOpen] = useState(true);
  const { user } = useAuth();
  const loc = useLocation();

  const Item = ({ to, label, icon: Icon, color, indent = false }) => {
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
      <div className="h-16 shrink-0 flex items-center gap-2 px-4 border-b">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-900 text-white shrink-0">
          <Sparkles size={16} />
        </div>
        {!collapsed && (
          <div>
            <div className="font-heading font-bold text-slate-900 leading-tight">Axiom</div>
            <div className="text-[10px] tracking-widest uppercase text-slate-500 leading-tight">Ledger</div>
          </div>
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
        {user?.role === "superadmin" && (
          <Item to="/admin" label="Superadmin" icon={Shield} color="#EF4444" />
        )}
        {(user?.role === "pro" || user?.role === "superadmin") && (
          <Item to="/pro/clients" label="Clients" icon={Briefcase} color="#3B82F6" />
        )}

        {NAV.map((n) => (
          <Item key={n.to} {...n} />
        ))}

        <div className="pt-2">
          <button
            data-testid={`${TID.navGroup}-accounting`}
            onClick={() => setAccOpen(!accOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-50 text-slate-800"
          >
            <ListTree size={17} style={{ color: "#3B82F6" }} />
            {!collapsed && (
              <>
                <span className="font-medium">Accounting</span>
                <span className="ml-auto">
                  {accOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              </>
            )}
          </button>
          {accOpen && !collapsed && (
            <div className="mt-0.5 space-y-0.5">
              {ACCOUNTING.map((a) => <Item key={a.to} {...a} indent />)}
            </div>
          )}
        </div>
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
