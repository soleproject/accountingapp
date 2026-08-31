/**
 * MobileShell (Feb 2026, Mobile UX Phase 1).
 *
 * Two components that only render on ≤767px viewports:
 *
 *   <MobileTopBar />   — 56px sticky header with hamburger, company
 *                        switcher, notification bell, profile menu.
 *   <MobileBottomNav /> — 64px sticky footer with 4 tabs (Home, CRM,
 *                        Accounting, Chat) + safe-area padding for
 *                        iPhone home indicator.
 *   <MobileDrawer />   — Slide-in sidebar drawer, opened by the
 *                        hamburger, closed by tapping the scrim.
 *
 * On desktop (≥768px) all three return `null` — the existing sidebar
 * + product rail + header stay exactly as they are. Zero regression
 * risk for laptop users.
 */

import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Menu, X, Home, Users, Calculator, MessageSquare, Bell } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { CompanySwitcher, ProfileMenu } from "@/components/Layout";
import NotificationBell from "@/components/NotificationBell";
import Sidebar from "@/components/Sidebar";
import { emitAction } from "@/lib/createBus";


export function MobileTopBar({ onOpenDrawer }) {
  return (
    <header
      data-testid="mobile-top-bar"
      className="sticky top-0 z-30 bg-white border-b border-slate-200 flex items-center gap-2 px-3 h-14"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Open menu"
        data-testid="mobile-menu-btn"
        className="w-11 h-11 grid place-items-center rounded-lg hover:bg-slate-100"
      >
        <Menu size={22} />
      </button>
      <div className="flex-1 min-w-0">
        <CompanySwitcher />
      </div>
      <NotificationBell />
      <ProfileMenu />
    </header>
  );
}


export function MobileDrawer({ open, onClose }) {
  // Close on route change so tapping a sidebar item closes the drawer
  // automatically without the user having to hit the X.
  const loc = useLocation();
  useEffect(() => { if (open) onClose(); /* eslint-disable-next-line */ }, [loc.pathname]);
  // Lock body scroll while the drawer is open so the underlying page
  // doesn't shift with iOS Safari's rubber-banding.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" data-testid="mobile-drawer">
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
        data-testid="mobile-drawer-scrim"
      />
      {/* Panel — slides in from the left, matches sidebar width */}
      <div className="absolute inset-y-0 left-0 w-72 max-w-[85%] bg-white shadow-2xl flex flex-col animate-slide-in">
        <div className="h-14 shrink-0 border-b flex items-center justify-between px-3"
             style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <div className="font-heading font-semibold text-sm">Menu</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            data-testid="mobile-drawer-close"
            className="w-10 h-10 grid place-items-center rounded-lg hover:bg-slate-100"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Sidebar collapsed={false} onToggle={() => {}} embedded />
        </div>
      </div>
    </div>
  );
}


const NAV_TABS = [
  { to: "/home",        label: "Home",       icon: Home,          matchStarts: ["/home"] },
  { to: "/crm",         label: "CRM",        icon: Users,         matchStarts: ["/crm"] },
  { to: "/dashboard",   label: "Accounting", icon: Calculator,    matchStarts: ["/dashboard", "/accounting"] },
];


export function MobileBottomNav() {
  const loc = useLocation();
  const nav = useNavigate();
  const { user } = useAuth();
  const enabled = user?.enabled_products || [];

  // Filter tabs the user doesn't have access to. Home is always
  // shown; CRM/Accounting only when the module is enabled for them.
  const visibleTabs = NAV_TABS.filter(t => {
    if (t.to === "/crm") return enabled.includes("crm");
    if (t.to === "/dashboard") return enabled.includes("accounting");
    return true;
  });

  const isActive = (tab) => tab.matchStarts.some(s => loc.pathname.startsWith(s));

  const openChat = () => {
    // AiPanel listens for `ai-open`; same event the header
    // Assistant button emits.
    emitAction("ai-open");
  };

  return (
    <nav
      data-testid="mobile-bottom-nav"
      className="fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 flex"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {visibleTabs.map(t => {
        const Icon = t.icon;
        const active = isActive(t);
        return (
          <button
            key={t.to}
            type="button"
            onClick={() => nav(t.to)}
            data-testid={`mobile-nav-${t.label.toLowerCase()}`}
            className={`flex-1 h-16 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
              active ? "text-cyan-600" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon size={22} strokeWidth={active ? 2.4 : 1.8} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={openChat}
        data-testid="mobile-nav-chat"
        className="flex-1 h-16 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-500 hover:text-slate-800"
      >
        <MessageSquare size={22} strokeWidth={1.8} />
        <span>Chat</span>
      </button>
    </nav>
  );
}
