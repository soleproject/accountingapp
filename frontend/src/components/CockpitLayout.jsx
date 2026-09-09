import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Sunrise, Kanban, MessageSquare, Receipt, FileBarChart2, Bot,
  Megaphone, Activity,
} from "lucide-react";

// --------------------------------------------------------------------------
// CockpitLayout — shared shell for every /cockpit/* page.
// Renders a left sub-rail (Today / Close / Client Requests / 1099 / Reports /
// Agents / Communications / Practice Health) + the routed page content.
// --------------------------------------------------------------------------

const RAILS = [
  { to: "/cockpit",                 label: "Today",           icon: Sunrise,       key: "today",  end: true },
  { to: "/cockpit/close",           label: "Close",           icon: Kanban,        key: "close" },
  { to: "/cockpit/requests",        label: "Client Requests", icon: MessageSquare, key: "requests" },
  { to: "/cockpit/1099",            label: "1099",            icon: Receipt,       key: "1099" },
  { to: "/cockpit/reports",         label: "Reports",         icon: FileBarChart2, key: "reports" },
  { to: "/cockpit/agents",          label: "Agents",          icon: Bot,           key: "agents" },
  { to: "/cockpit/communications",  label: "Communications",  icon: Megaphone,     key: "comms" },
  { to: "/cockpit/practice-health", label: "Practice Health", icon: Activity,      key: "health" },
];

export default function CockpitLayout() {
  const loc = useLocation();
  const activeKey = (() => {
    if (loc.pathname === "/cockpit" || loc.pathname === "/cockpit/today") return "today";
    const seg = loc.pathname.split("/")[2] || "today";
    return {
      close: "close", requests: "requests", "1099": "1099",
      reports: "reports", agents: "agents", communications: "comms",
      "practice-health": "health",
    }[seg] || "today";
  })();

  return (
    <div className="flex min-h-[calc(100vh-4rem)] bg-slate-50" data-testid="cockpit-shell">
      {/* Sub-rail */}
      <aside
        className="w-56 shrink-0 border-r border-slate-200 bg-white py-4 hidden md:block"
        data-testid="cockpit-rail"
      >
        <div className="px-4 pb-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Cockpit
          </div>
          <div className="font-heading text-lg font-bold text-slate-900">
            Practice
          </div>
        </div>
        <nav className="space-y-0.5 px-2">
          {RAILS.map((r) => {
            const Icon = r.icon;
            const active = activeKey === r.key;
            return (
              <NavLink
                key={r.key}
                to={r.to}
                end={r.end}
                data-testid={`cockpit-rail-${r.key}`}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-indigo-50 text-indigo-700 font-semibold"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <Icon size={16} className={active ? "text-indigo-600" : "text-slate-500"} />
                <span className="truncate">{r.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      {/* Content pane */}
      <main className="flex-1 min-w-0" data-testid="cockpit-content">
        <Outlet />
      </main>
    </div>
  );
}
