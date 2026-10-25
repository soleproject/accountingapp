import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Scale, Play, Pause, Search, MessagesSquare, Bell, CircleHelp, ChevronDown,
  Settings, CreditCard, LogOut, Calculator, Check, ChevronsLeft,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { usePracticeTimer, timer, fmtClock } from "@/components/practice/timerStore";

function TopTimerButton({ railHidden, onShowRail }) {
  const { active, running, seconds } = usePracticeTimer();
  const onClick = () => { if (!active) timer.start(); else if (railHidden) onShowRail(); };
  return (
    <button type="button" onClick={onClick} data-testid="practice-start-timer-btn" data-running={running}
            className="h-7 pl-2 pr-3 rounded-full bg-[#43A047] text-xs font-bold flex items-center gap-1.5 hover:bg-[#4CAF50] transition-colors tabular-nums">
      <span className="h-4 w-4 rounded-full bg-white grid place-items-center">
        {active && !running ? <Pause size={9} className="text-[#43A047] fill-[#43A047]" /> : <Play size={9} className="text-[#43A047] fill-[#43A047] ml-px" />}
      </span>
      {active ? <span data-testid="practice-top-timer-clock">{fmtClock(seconds)}</span> : "Start Timer"}
    </button>
  );
}

const NAV = [
  { label: "Home", to: "/practice", exact: true }, { label: "Matters", to: "/practice/matters" }, { label: "Contacts", to: "/practice/contacts" }, { label: "Calendar", to: "/practice/calendar" }, { label: "Time Entries", to: "/practice/time-entries" },
  { label: "Billing", menu: true }, { label: "Payments", menu: true },
  { label: "Activities", menu: true }, { label: "Documents", menu: true },
  "Reports",
];

const PRODUCTS = [
  { key: "accounting", label: "Accounting", icon: Calculator, to: "/dashboard" },
  { key: "practice", label: "Practice", icon: Scale, to: "/practice" },
];

function ProfileMenu({ user }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const nav = useNavigate();
  const { logout } = useAuth();

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const initials = (user?.name || "?").split(" ").map(s => s[0]).join("").slice(0, 2).toUpperCase();
  const item = "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left";

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
              data-testid="practice-profile-menu-trigger"
              className="flex items-center gap-2 text-white hover:text-white/85 transition-colors">
        <span className="h-8 w-8 rounded-full bg-white/25 grid place-items-center text-xs font-bold">{initials}</span>
        <span className="hidden sm:block font-semibold text-[15px]">{user?.name}</span>
        <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div data-testid="practice-profile-menu"
             className="absolute right-0 top-full mt-2 w-56 rounded-md border border-slate-200 bg-white shadow-xl py-1 z-50 text-slate-800">
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Product</div>
          {PRODUCTS.map(p => {
            const Icon = p.icon;
            const active = p.key === "practice";
            return (
              <button key={p.key} type="button" onClick={() => { setOpen(false); nav(p.to); }}
                      data-testid={`practice-product-switch-${p.key}`}
                      className={`${item} ${active ? "font-semibold text-slate-900" : ""}`}>
                <Icon size={15} className={active ? "text-[#1E88E5]" : "text-slate-500"} />
                <span className="flex-1">{p.label}</span>
                {active && <Check size={14} className="text-[#1E88E5]" />}
              </button>
            );
          })}
          <div className="my-1 border-t border-slate-200" />
          <button type="button" className={item} data-testid="practice-menu-settings" onClick={() => { setOpen(false); nav("/practice/settings"); }}>
            <Settings size={15} className="text-slate-500" /> Settings
          </button>
          <button type="button" className={item} data-testid="practice-menu-subscription" onClick={() => setOpen(false)}>
            <CreditCard size={15} className="text-slate-500" /> Subscription
          </button>
          <button type="button" className={item} data-testid="practice-menu-signout" onClick={logout}>
            <LogOut size={15} className="text-slate-500" /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

export const PracticeTopNav = ({ user, railHidden = false, onShowRail }) => {
  const nav = useNavigate();
  const { pathname } = useLocation();
  return (
  <header className="bg-[#1E88E5] text-white" data-testid="practice-topnav">
    <div className="flex items-center gap-3 px-4 h-14">
      <div className="flex items-center gap-2 pr-2" data-testid="practice-brand">
        <span className="h-8 w-8 rounded-md bg-white grid place-items-center">
          <Scale size={18} className="text-[#1E88E5]" strokeWidth={2.5} />
        </span>
        <span className="text-xl font-bold tracking-tight">Practice</span>
      </div>
      <button type="button" data-testid="practice-new-btn"
              className="h-7 px-3 rounded-full bg-[#29B6F6] text-xs font-bold hover:bg-[#4FC3F7] transition-colors">
        + New
      </button>
      <TopTimerButton onShowRail={onShowRail} railHidden={railHidden} />
      <div className="flex-1" />
      <button type="button" className="p-1.5 hover:bg-white/15 rounded" data-testid="practice-messages-btn"><MessagesSquare size={19} /></button>
      <button type="button" className="p-1.5 hover:bg-white/15 rounded" data-testid="practice-notifications-btn"><Bell size={19} /></button>
      <button type="button" className="p-1.5 hover:bg-white/15 rounded" data-testid="practice-help-btn"><CircleHelp size={19} /></button>
      <ProfileMenu user={user} />
    </div>
    <div className="flex items-center gap-1 px-4 pb-2.5 overflow-x-auto">
      <label className="relative mr-3 shrink-0">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input placeholder="Search" data-testid="practice-search-input"
               className="h-8 w-52 rounded-full bg-white pl-8 pr-3 text-sm text-slate-700 outline-none" />
      </label>
      {NAV.map(n => {
        const label = typeof n === "string" ? n : n.label;
        const menu = typeof n !== "string" && n.menu;
        const to = typeof n !== "string" ? n.to : null;
        const active = to && (n.exact ? pathname === to : pathname.startsWith(to));
        return (
          <button key={label} type="button" data-testid={`practice-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                  onClick={() => to && nav(to)}
                  className={`shrink-0 px-3 py-1 text-[15px] font-semibold hover:bg-white/15 rounded flex items-center gap-1 ${active ? "bg-white/20" : ""}`}>
            {label}{menu && <ChevronDown size={12} />}
          </button>
        );
      })}
      <div className="flex-1" />
      <label className="shrink-0 flex items-center gap-2 text-sm font-semibold cursor-pointer" data-testid="practice-privacy-toggle">
        <span className="h-5 w-9 rounded-full bg-white/90 relative"><span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#1E88E5]" /></span>
        Privacy
      </label>
      {railHidden && (
        <button type="button" onClick={onShowRail} title="Show Sidebar" data-testid="practice-show-sidebar-btn"
                className="shrink-0 ml-1 p-1 rounded hover:bg-white/15" aria-label="Show Sidebar">
          <ChevronsLeft size={18} />
        </button>
      )}
    </div>
  </header>
  );
};
