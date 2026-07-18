import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import AiPanel from "./AiPanel";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { ChevronDown, LogOut, MessageSquare } from "lucide-react";
import { Toaster } from "sonner";
import { AiFocusProvider } from "@/lib/aiFocus";
import { useActionListener } from "@/lib/createBus";

function CompanySwitcher() {
  const { companies, current, switchCompany } = useCompany();
  const [open, setOpen] = useState(false);
  if (!companies?.length) return null;
  return (
    <div className="relative">
      <button
        data-testid={TID.companySwitcher}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200 hover:border-slate-300 bg-white text-sm"
      >
        <span className="font-heading font-semibold">{current?.name || "Select company"}</span>
        <ChevronDown size={14} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 w-72 rounded-md border bg-white shadow-lg py-1">
          {companies.map(c => (
            <button
              key={c.id}
              data-testid={`${TID.companySwitcherOption}-${c.id}`}
              onClick={() => { switchCompany(c.id); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-[11px] text-slate-500">{c.business_type || "—"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiCollapsed, setAiCollapsed] = useState(false);
  const { user, logout } = useAuth();
  // Row-level "Ask AI" buttons emit `ai-open` — expand the panel when it fires.
  useActionListener("ai-open", () => setAiCollapsed(false));

  return (
    <AiFocusProvider>
      <div className="flex h-screen overflow-hidden bg-[#F5F6F8]">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 shrink-0 border-b bg-white flex items-center px-6 gap-4">
            <CompanySwitcher />
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-slate-500 hidden md:inline">{user?.email}</span>
              {aiCollapsed && (
                <button
                  data-testid={TID.aiPanelToggle + "-header"}
                  onClick={() => setAiCollapsed(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
                >
                  <MessageSquare size={13} /> Assistant
                </button>
              )}
              <button
                data-testid={TID.signoutBtn}
                onClick={logout}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs text-slate-700 hover:bg-slate-50"
              >
                <LogOut size={13} /> Sign out
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-auto p-6 md:p-8">
            <Outlet />
          </main>
        </div>

        <AiPanel collapsed={aiCollapsed} onToggle={() => setAiCollapsed(!aiCollapsed)} />
        <Toaster position="bottom-right" />
      </div>
    </AiFocusProvider>
  );
}
